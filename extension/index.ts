/**
 * aX Platform Integration Extension
 *
 * Enables moltbot to receive webhook dispatches from aX backend.
 * Follows the same input/output pattern as agent_runner:
 *
 * 1. Backend POSTs dispatch payload (input)
 * 2. Moltbot processes with its LLM
 * 3. Moltbot can use aX MCP tools for auxiliary actions (spaces, tasks, context)
 * 4. Moltbot returns response content (output)
 * 5. Backend posts the response as a message
 *
 * Also handles webhook verification (WebSub-style challenge-response).
 *
 * MCP tools are for navigation/context, NOT for sending the main response.
 * "Agents think; Infrastructure acts."
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

const execAsync = promisify(exec);
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

// =============================================================================
// MCP Client - Proxy calls to aX MCP endpoint
// =============================================================================

interface McpRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

interface McpResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

let mcpRequestId = 0;

// =============================================================================
// Progress Reporting - POST updates to backend during processing
// =============================================================================

async function sendProgressUpdate(
  logger: ClawdbotPluginApi["logger"],
  authToken: string,
  dispatchId: string,
  status: "processing" | "completed" | "error",
  tool?: string,
  message?: string,
): Promise<void> {
  // Backend endpoint for progress updates
  // Gateway runs on host, so use localhost:8001 (Docker maps 8001->8080)
  const backendUrl = process.env.AX_BACKEND_URL || "http://localhost:8001";
  const progressUrl = `${backendUrl}/api/v1/webhooks/progress`;

  try {
    const response = await fetch(progressUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        dispatch_id: dispatchId,
        status,
        tool,
        message,
      }),
    });

    if (response.ok) {
      logger.info(`[ax-platform] Progress update sent: ${tool || status} - ${message || ''}`);
    } else {
      logger.warn(`[ax-platform] Progress update failed: ${response.status}`);
    }
  } catch (err) {
    // Fire-and-forget - don't fail the dispatch if progress reporting fails
    logger.warn(`[ax-platform] Progress update error (non-fatal): ${err}`);
  }
}

// Token refresh on 401 - uses webhook_secret to sign refresh request
async function refreshToken(
  logger: ClawdbotPluginApi["logger"],
): Promise<boolean> {
  const endpoint = process.env.AX_MCP_ENDPOINT;
  const agentId = process.env.AX_AGENT_ID;
  const webhookSecret = process.env.AX_WEBHOOK_SECRET;

  if (!endpoint || !agentId || !webhookSecret) {
    logger.warn("[ax-platform] Cannot refresh token: missing endpoint, agent_id, or webhook_secret");
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${agentId}.${timestamp}`;

  // HMAC-SHA256 signature using webhook_secret
  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(payload)
    .digest("hex");

  logger.info("[ax-platform] Attempting token refresh...");

  try {
    // For local: use backend URL directly (on ax-shared network)
    // For prod: derive from MCP endpoint
    const isLocal = endpoint.includes("localhost") || endpoint.includes("pax-platform-mcp");
    const backendUrl = isLocal
      ? "http://pax-platform-api:8000"
      : endpoint.replace("/mcp", "").replace("mcp.", "api.");

    const response = await fetch(`${backendUrl}/api/v1/webhooks/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        timestamp: timestamp,
        signature: signature,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[ax-platform] Token refresh failed ${response.status}: ${text.substring(0, 200)}`);
      return false;
    }

    const data = (await response.json()) as { token?: string; auth_token?: string };
    const newToken = data.token || data.auth_token;

    if (newToken) {
      process.env.AX_AUTH_TOKEN = newToken;
      logger.info("[ax-platform] Token refreshed successfully");
      return true;
    }

    logger.error("[ax-platform] Token refresh response missing token");
    return false;
  } catch (err) {
    logger.error(`[ax-platform] Token refresh error: ${err}`);
    return false;
  }
}

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  logger: ClawdbotPluginApi["logger"],
  retried = false,
): Promise<unknown> {
  const endpoint = process.env.AX_MCP_ENDPOINT;
  const token = process.env.AX_AUTH_TOKEN;

  console.log(`[ax-platform] MCP tool call: ${toolName}`);
  console.log(`[ax-platform]   endpoint: ${endpoint ? endpoint.substring(0, 50) : 'MISSING'}`);
  console.log(`[ax-platform]   token: ${token ? token.substring(0, 20) + '...' : 'MISSING'}`);

  if (!endpoint || !token) {
    logger.warn("[ax-platform] MCP call failed: missing endpoint or token");
    return { error: "MCP not configured - missing endpoint or auth token" };
  }

  const request: McpRequest = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
    id: ++mcpRequestId,
  };

  logger.info(`[ax-platform] MCP call: ${toolName} -> ${endpoint}`);

  try {
    const response = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    // On 401, try to refresh token and retry once
    if (response.status === 401 && !retried) {
      logger.warn("[ax-platform] Got 401, attempting token refresh...");
      const refreshed = await refreshToken(logger);
      if (refreshed) {
        logger.info("[ax-platform] Retrying MCP call with new token...");
        return callMcpTool(toolName, args, logger, true);
      }
      return { error: "Token expired and refresh failed" };
    }

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[ax-platform] MCP HTTP error ${response.status}: ${text.substring(0, 200)}`);
      return { error: `MCP request failed: ${response.status}` };
    }

    const mcpResponse = (await response.json()) as McpResponse;

    if (mcpResponse.error) {
      logger.error(`[ax-platform] MCP error: ${mcpResponse.error.message}`);
      return { error: mcpResponse.error.message };
    }

    logger.info(`[ax-platform] MCP success: ${toolName}`);
    return mcpResponse.result;
  } catch (err) {
    logger.error(`[ax-platform] MCP fetch error: ${err}`);
    return { error: `MCP network error: ${err}` };
  }
}

// Helper to format MCP result for display
function formatMcpResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    // Handle content array format from MCP
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return r.content
        .map((c: { type?: string; text?: string }) => c.text || JSON.stringify(c))
        .join("\n");
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

// =============================================================================
// Types
// =============================================================================

// V3 Payload structure (flat, not nested)
interface AxDispatchPayload {
  payload_version?: string;
  dispatch_id: string;
  agent_id: string;
  agent_name?: string;
  agent_handle?: string;
  space_id?: string;
  space_name?: string;
  message_id?: string;
  org_id?: string;
  // Sender info at top level in V3
  sender_handle?: string;
  sender_id?: string;
  sender_type?: string;
  owner_handle?: string;
  owner_id?: string;
  // Message content (V3 uses user_message)
  user_message?: string;
  content?: string;
  message_content?: string;
  // System prompt with aX context (identity, chat history)
  system_prompt?: string;
  // Auth
  auth_token?: string;
  mcp_endpoint?: string;
  // Legacy nested message (V2 fallback)
  message?: {
    content: string;
    sender_handle: string;
    sender_id: string;
    message_id?: string;
  };
  feature_flags?: {
    web_browsing?: boolean;
    ax_mcp?: boolean;
    image_generation?: boolean;
  };
}

interface AxDispatchResponse {
  status: "success" | "error";
  dispatch_id: string;
  response?: string;
  error?: string;
}

// =============================================================================
// Configuration
// =============================================================================

// Webhook secret for HMAC verification (set via env or config)
const getWebhookSecret = (): string | undefined => {
  return process.env.AX_WEBHOOK_SECRET;
};

// =============================================================================
// Verification Handler (WebSub-style challenge-response)
// =============================================================================

function handleVerification(
  req: IncomingMessage,
  res: ServerResponse,
  api: ClawdbotPluginApi,
): boolean {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  // Check for WebSub verification params
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const agentId = url.searchParams.get("hub.agent_id");

  if (mode === "subscribe" && challenge) {
    api.logger.info(`[ax-platform] Verification request for agent ${agentId}`);

    // Echo the challenge back as plain text
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(challenge);

    api.logger.info("[ax-platform] Verification successful - challenge echoed");
    return true;
  }

  return false;
}

// =============================================================================
// HMAC Signature Verification
// =============================================================================

function verifySignature(
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
): { valid: boolean; error?: string } {
  if (!signature) {
    return { valid: false, error: "Missing X-AX-Signature header" };
  }

  if (!timestamp) {
    return { valid: false, error: "Missing X-AX-Timestamp header" };
  }

  // Check timestamp is within 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300) {
    return { valid: false, error: "Timestamp expired or invalid (>5 min)" };
  }

  // Verify HMAC-SHA256 signature
  // Signature format: "sha256={hash}"
  const expectedSig = signature.replace("sha256=", "");
  const payload = `${timestamp}.${body}`;
  const computedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(computedSig))) {
    return { valid: false, error: "Invalid signature" };
  }

  return { valid: true };
}

// =============================================================================
// Dispatch Handler
// =============================================================================

function createAxDispatchHandler(api: ClawdbotPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // Only handle /ax/dispatch path
    if (!req.url?.startsWith("/ax/dispatch")) {
      return false;
    }

    // Handle GET verification requests
    if (req.method === "GET") {
      return handleVerification(req, res, api);
    }

    // Handle POST dispatch requests
    if (req.method !== "POST") {
      return false;
    }

    api.logger.info("[ax-platform] Received dispatch request");

    try {
      // Parse request body
      api.logger.info("[ax-platform] Reading body...");
      const body = await readBody(req);
      api.logger.info(`[ax-platform] Body received (${body.length} bytes)`);

      // Verify HMAC signature if secret is configured
      const webhookSecret = getWebhookSecret();
      api.logger.info(`[ax-platform] Webhook secret configured: ${!!webhookSecret}`);

      // Debug: log first 1000 chars of payload
      api.logger.info(`[ax-platform] Payload preview: ${body.substring(0, 1000)}`);

      // Check if auth_token is in the payload
      const hasAuthToken = body.includes('"auth_token"');
      const hasMcpEndpoint = body.includes('"mcp_endpoint"');
      api.logger.info(`[ax-platform] Has auth_token: ${hasAuthToken}, Has mcp_endpoint: ${hasMcpEndpoint}`);

      if (webhookSecret) {
        const signature = req.headers["x-ax-signature"] as string | undefined;
        const timestamp = req.headers["x-ax-timestamp"] as string | undefined;

        const verification = verifySignature(body, signature, timestamp, webhookSecret);
        if (!verification.valid) {
          api.logger.warn(`[ax-platform] Signature verification failed: ${verification.error}`);
          sendJson(res, 401, {
            status: "error",
            dispatch_id: "unknown",
            error: verification.error,
          } satisfies AxDispatchResponse);
          return true;
        }
      }

      api.logger.info(`[ax-platform] Parsing JSON...`);
      const payload = JSON.parse(body) as AxDispatchPayload;
      api.logger.info(`[ax-platform] JSON parsed. dispatch_id=${payload.dispatch_id}, agent_handle=${payload.agent_handle}`);

      // Validate required fields (auth_token optional for V3 which uses header auth)
      const agentHandle = payload.agent_handle || payload.agent_name;
      // Generate dispatch_id from message_id if not provided (external agents may not have it)
      const dispatchId = payload.dispatch_id || payload.message_id || `ext-${Date.now()}`;
      if (!agentHandle) {
        api.logger.warn(`[ax-platform] Validation failed: agent_handle=${agentHandle}`);
        sendJson(res, 400, {
          status: "error",
          dispatch_id: dispatchId,
          error: "Missing required field: agent_handle/agent_name",
        } satisfies AxDispatchResponse);
        return true;
      }
      // Use generated dispatch_id for the rest of the flow
      payload.dispatch_id = dispatchId;
      api.logger.info(`[ax-platform] Validation passed (dispatch_id=${dispatchId})`);

      // V3 has sender_handle at top level, V2 has it nested in message
      const senderHandle = payload.sender_handle || payload.message?.sender_handle || "unknown";
      api.logger.info(
        `[ax-platform] Dispatch ${payload.dispatch_id} from @${senderHandle}`,
      );

      // Store auth token for MCP tool calls (spaces, tasks, context, search)
      // Agent can use these for auxiliary actions during processing
      process.env.AX_AUTH_TOKEN = payload.auth_token;
      process.env.AX_MCP_ENDPOINT = payload.mcp_endpoint;
      process.env.AX_DISPATCH_ID = payload.dispatch_id;
      process.env.AX_SPACE_ID = payload.space_id || "";
      process.env.AX_AGENT_ID = payload.agent_id;

      // Process the message and get the response (synchronous pattern)
      api.logger.info(`[ax-platform] Calling processDispatch...`);
      const response = await processDispatch(api, payload);
      api.logger.info(`[ax-platform] processDispatch returned: ${response.substring(0, 100)}`);

      // Return the response - backend will post it as a message
      api.logger.info(`[ax-platform] Sending 200 response`);
      sendJson(res, 200, {
        status: "success",
        dispatch_id: payload.dispatch_id,
        response: response,
      } satisfies AxDispatchResponse);

      return true;
    } catch (err) {
      api.logger.error(`[ax-platform] Dispatch error: ${err}`);
      sendJson(res, 500, {
        status: "error",
        dispatch_id: "unknown",
        error: `Processing error: ${err}`,
      } satisfies AxDispatchResponse);
      return true;
    }
  };
}

async function processDispatch(api: ClawdbotPluginApi, payload: AxDispatchPayload): Promise<string> {
  // V3 uses user_message for the content
  const prompt = payload.user_message || payload.content || payload.message?.content;
  if (!prompt) {
    api.logger.warn(`[ax-platform] No content found in payload. Keys: ${Object.keys(payload).join(', ')}`);
    return "No message content received.";
  }

  api.logger.info(`[ax-platform] Got user_message: ${prompt.substring(0, 100)}`);

  const sender = payload.sender_handle || payload.message?.sender_handle || "unknown";

  api.logger.info(`[ax-platform] Processing message from @${sender}: ${prompt.substring(0, 80)}...`);

  // Log if we have system_prompt from aX
  if (payload.system_prompt) {
    api.logger.info(`[ax-platform] Has system_prompt (${payload.system_prompt.length} chars)`);
  }

  try {
    // One container per agent - agent_id is the identity
    const sessionId = `ax-agent-${payload.agent_id || 'default'}`;

    // Extract just the message content (remove the "username (type): " prefix if present)
    let cleanPrompt = prompt;
    const prefixMatch = prompt.match(/^[^:]+:\s*@?\w+\s*/);
    if (prefixMatch) {
      cleanPrompt = prompt.substring(prefixMatch[0].length).trim();
    }

    // Build context block from aX system_prompt or fallback to simple context
    // Always include reply instruction to @mention the sender
    const replyInstruction = `\n\nIMPORTANT: Always start your reply with @${sender} to mention who you're responding to.\n`;

    let contextBlock: string;
    if (payload.system_prompt) {
      // Use the full aX system prompt which includes identity, platform context, chat history
      contextBlock = `<ax-context>\n${payload.system_prompt}${replyInstruction}</ax-context>\n\nUser message: `;
    } else {
      // Fallback: simple sender context
      const senderType = payload.sender_type || 'unknown';
      contextBlock = `[From @${sender} (${senderType}) in ${payload.space_name || 'aX'}]${replyInstruction}`;
    }
    const promptWithContext = contextBlock + cleanPrompt;

    // Escape for shell
    const escapedPrompt = promptWithContext.replace(/'/g, "'\\''");

    api.logger.info(`[ax-platform] Calling moltbot agent with session ${sessionId}...`);

    // Send "thinking" progress update so frontend shows spinner
    if (payload.auth_token && payload.dispatch_id) {
      sendProgressUpdate(
        api.logger,
        payload.auth_token,
        payload.dispatch_id,
        "processing",
        "thinking",
        "Processing request..."
      ).catch(() => {}); // Fire-and-forget
    }

    // Pass aX env vars explicitly to subprocess so tools can access them
    const subprocessEnv = {
      ...process.env,
      AX_AUTH_TOKEN: payload.auth_token || '',
      AX_MCP_ENDPOINT: payload.mcp_endpoint || '',
      AX_AGENT_ID: payload.agent_id || '',
      AX_SPACE_ID: payload.space_id || '',
      AX_DISPATCH_ID: payload.dispatch_id || '',
    };

    // Use clawdbot CLI - full path needed since gateway subprocess doesn't have user's PATH
    const clawdbotCmd = process.env.CLAWDBOT_CMD || '/Users/jacob/.npm-global/bin/clawdbot';
    const { stdout, stderr } = await execAsync(
      `${clawdbotCmd} agent --message '${escapedPrompt}' --session-id '${sessionId}' --local --json 2>&1`,
      {
        timeout: 120000, // 120 second timeout
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
        env: subprocessEnv,
      }
    );

    if (stderr) {
      api.logger.warn(`[ax-platform] Agent stderr: ${stderr.substring(0, 200)}`);
    }

    const output = stdout.trim();
    api.logger.info(`[ax-platform] Agent output length: ${output.length}`);

    // Parse JSON response - clawdbot --json outputs { payloads: [{ text: "..." }], meta: {...} }
    try {
      // Filter out log/color lines first, then find JSON
      const lines = output.split('\n');
      const jsonLines: string[] = [];
      let inJson = false;

      for (const line of lines) {
        // Skip ANSI color codes and log lines
        const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (cleanLine.startsWith('{') || inJson) {
          inJson = true;
          jsonLines.push(line);
        }
      }

      const jsonStr = jsonLines.join('\n').trim();
      if (jsonStr) {
        api.logger.info(`[ax-platform] Found JSON (${jsonStr.length} chars)`);
        api.logger.info(`[ax-platform] JSON preview: ${jsonStr.substring(0, 300)}`);

        // IMPORTANT: clawdbot --json can output duplicate "text" keys (invalid JSON)
        // JSON.parse() only keeps one, so we extract ALL text values from raw string first
        const textValues: string[] = [];
        const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let match;
        while ((match = textRegex.exec(jsonStr)) !== null) {
          // Unescape JSON string (handle \n, \", etc.)
          const unescaped = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          textValues.push(unescaped);
        }

        if (textValues.length > 0) {
          api.logger.info(`[ax-platform] Found ${textValues.length} text values in raw JSON`);
          // Concatenate all text values with newlines
          const response = textValues.join('\n\n');
          api.logger.info(`[ax-platform] Combined response: ${response.substring(0, 100)}...`);
          return response;
        }

        // Fallback to standard JSON parsing if regex didn't find text
        const json = JSON.parse(jsonStr);
        api.logger.info(`[ax-platform] Parsed JSON keys: ${Object.keys(json).join(', ')}`);

        // Extract text from payloads array
        if (json.payloads && Array.isArray(json.payloads)) {
          api.logger.info(`[ax-platform] Found payloads array with ${json.payloads.length} items`);
          if (json.payloads[0]?.text) {
            const response = json.payloads[0].text;
            api.logger.info(`[ax-platform] Extracted response: ${response.substring(0, 100)}...`);
            return response;
          } else {
            api.logger.warn(`[ax-platform] payloads[0] has no text. Keys: ${Object.keys(json.payloads[0] || {}).join(', ')}`);
          }
        }

        // Fallback to other fields
        const response = json.response || json.content || json.text || json.message;
        if (response) {
          api.logger.info(`[ax-platform] Fallback response: ${response.substring(0, 100)}...`);
          return response;
        }

        api.logger.warn(`[ax-platform] JSON parsed but no text found. Keys: ${Object.keys(json).join(', ')}`);
      }
    } catch (parseErr) {
      api.logger.warn(`[ax-platform] JSON parse failed: ${parseErr}`);
    }

    // Return raw output if not JSON, filtering out log lines
    const cleanLines = output.split('\n').filter(line => {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      return clean && !clean.startsWith('[') && !clean.includes('◇') && !clean.includes('│');
    });
    const cleanOutput = cleanLines.join('\n').trim();

    return cleanOutput || output || "I processed your message but have no response.";
  } catch (err) {
    api.logger.error(`[ax-platform] Agent error: ${err}`);
    return `Hello @${sender}! I received your message but encountered an error processing it. Please try again.`;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// =============================================================================
// Registration Handler - Self-register with aX backend
// =============================================================================

interface RegisterRequest {
  name: string;
  webhook_url: string;
  api_url?: string; // Defaults to production
}

interface RegisterResponse {
  status: "success" | "error";
  agent_id?: string;
  agent_handle?: string;
  webhook_secret?: string;
  webhook_verified?: boolean;
  error?: string;
}

function createAxRegisterHandler(api: ClawdbotPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // Only handle /ax/register path
    if (!req.url?.startsWith("/ax/register")) {
      return false;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed. Use POST." });
      return true;
    }

    api.logger.info("[ax-platform] Registration request received");

    try {
      const body = await readBody(req);
      const request = JSON.parse(body) as RegisterRequest;

      if (!request.name || !request.webhook_url) {
        sendJson(res, 400, {
          status: "error",
          error: "Missing required fields: name, webhook_url",
        } satisfies RegisterResponse);
        return true;
      }

      // Default to production API
      const apiUrl = request.api_url || "https://api.paxai.app";

      api.logger.info(`[ax-platform] Registering agent "${request.name}" with webhook ${request.webhook_url}`);

      // Call backend registration endpoint
      const registerResponse = await fetch(`${apiUrl}/api/v1/agents/register-external`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: request.name,
          webhook_url: request.webhook_url,
          origin: "external_gateway",
          sub_type: "moltbot",
        }),
      });

      if (!registerResponse.ok) {
        const errorText = await registerResponse.text();
        api.logger.error(`[ax-platform] Registration failed: ${registerResponse.status} - ${errorText}`);
        sendJson(res, registerResponse.status, {
          status: "error",
          error: `Backend registration failed: ${errorText.substring(0, 200)}`,
        } satisfies RegisterResponse);
        return true;
      }

      const result = await registerResponse.json() as {
        agent_id?: string;
        agent_handle?: string;
        webhook_secret?: string;
        webhook_verified?: boolean;
      };

      // Store webhook secret in environment for this session
      if (result.webhook_secret) {
        process.env.AX_WEBHOOK_SECRET = result.webhook_secret;
        process.env.AX_AGENT_ID = result.agent_id;
        api.logger.info(`[ax-platform] Stored webhook_secret for agent ${result.agent_id}`);
      }

      api.logger.info(`[ax-platform] Registration successful! Agent: ${result.agent_handle}`);

      sendJson(res, 200, {
        status: "success",
        agent_id: result.agent_id,
        agent_handle: result.agent_handle,
        webhook_secret: result.webhook_secret,
        webhook_verified: result.webhook_verified,
      } satisfies RegisterResponse);

      return true;
    } catch (err) {
      api.logger.error(`[ax-platform] Registration error: ${err}`);
      sendJson(res, 500, {
        status: "error",
        error: `Registration failed: ${err}`,
      } satisfies RegisterResponse);
      return true;
    }
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

const plugin = {
  id: "ax-platform",
  name: "aX Platform Integration",
  description: "Receive aX webhook dispatches with input/output pattern",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    api.logger.info("[ax-platform] Extension loading...");

    // Register HTTP handlers
    const dispatchHandler = createAxDispatchHandler(api);
    const registerHandler = createAxRegisterHandler(api);

    api.registerHttpHandler(dispatchHandler);
    api.registerHttpHandler(registerHandler);

    api.logger.info("[ax-platform] Registered /ax/dispatch endpoint");
    api.logger.info("[ax-platform]   GET  - WebSub verification (hub.challenge)");
    api.logger.info("[ax-platform]   POST - Dispatch (input -> process -> output)");
    api.logger.info("[ax-platform] Registered /ax/register endpoint");
    api.logger.info("[ax-platform]   POST - Self-register agent with aX backend");
  },
};

export default plugin;
