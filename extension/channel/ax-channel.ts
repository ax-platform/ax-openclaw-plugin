/**
 * aX Platform Channel Plugin
 *
 * Registers aX as a Clawdbot channel for bidirectional messaging.
 *
 * Session Management Strategy:
 *
 * 1. sessionKey: `ax-agent-{agent_id}-{space_id}`
 *    - Purpose: Conversation continuity within a space
 *    - Used by: Clawdbot dispatcher for message history
 *    - Lifetime: Persists across multiple dispatches
 *
 * 2. dispatchId: Unique per webhook request
 *    - Purpose: Isolate concurrent dispatch contexts (auth tokens, MCP endpoint)
 *    - Used by: Tools/hooks to access dispatch-specific metadata
 *    - Lifetime: Deleted shortly after dispatch completes (with grace period)
 *
 * This dual-key strategy prevents session context collisions when multiple
 * dispatches arrive concurrently for the same agent, while maintaining
 * conversation continuity across messages.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "clawdbot/plugin-sdk";
import type { AxDispatchPayload, AxDispatchResponse, DispatchSession } from "../lib/types.js";
import { loadAgentRegistry, getAgent, verifySignature, logRegisteredAgents } from "../lib/auth.js";
import { sendProgressUpdate } from "../lib/api.js";
import { buildMissionBriefing } from "../lib/context.js";

// Constants
const DEDUP_TTL_MS = 15 * 60 * 1000; // 15 minutes (must exceed backend timeout of 10 min)
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 1000; // Clean up every minute
const SESSION_CLEANUP_DELAY_MS = 1000; // Grace period before session cleanup
const LOG_PREVIEW_LENGTH = 100; // Max chars to show in log previews

// Dispatch state for deduplication
type DispatchState = {
  status: "in_progress" | "completed";
  startedAt: number;
  response?: string; // Cached response for retries after completion
};

// Runtime instance (set during plugin registration)
let runtime: PluginRuntime | null = null;

export function setAxPlatformRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getAxPlatformRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("aX Platform runtime not initialized");
  }
  return runtime;
}

// Store active dispatch sessions - keyed by dispatchId (not sessionKey!)
// This allows multiple concurrent dispatches without overwriting each other
const dispatchSessions = new Map<string, DispatchSession>();

// Secondary index: sessionKey -> dispatchId for O(1) lookup
const sessionKeyIndex = new Map<string, string>();

// Deduplication: track dispatch state (TTL-based)
// Prevents duplicate processing when aX backend retries due to timeout
const dispatchStates = new Map<string, DispatchState>();

// Periodic cleanup interval handle (for proper shutdown)
let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic cleanup of expired deduplication entries
 * Prevents memory leak during low-traffic periods
 */
function startPeriodicCleanup(): void {
  if (cleanupIntervalHandle) return; // Already running
  cleanupIntervalHandle = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of dispatchStates) {
      if (now - state.startedAt > DEDUP_TTL_MS) {
        dispatchStates.delete(id);
      }
    }
  }, DEDUP_CLEANUP_INTERVAL_MS);
}

/**
 * Stop periodic cleanup (called on gateway stop)
 */
function stopPeriodicCleanup(): void {
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }
}

// Backend timeout threshold - match backend timeout so first retry = timeout
// Backend default is 30s, so any retry means we already exceeded the limit
const BACKEND_TIMEOUT_MS = 30 * 1000; // 30 seconds

/**
 * Check dispatch state for deduplication
 * Returns: "new" | "in_progress" | "timed_out" | "completed"
 */
function checkDispatchState(dispatchId: string): {
  status: "new" | "in_progress" | "timed_out" | "completed";
  response?: string;
  elapsedMs?: number;
} {
  const state = dispatchStates.get(dispatchId);

  if (!state) {
    // New dispatch - mark as in_progress
    dispatchStates.set(dispatchId, { status: "in_progress", startedAt: Date.now() });
    return { status: "new" };
  }

  if (state.status === "in_progress") {
    const elapsedMs = Date.now() - state.startedAt;
    // If we've exceeded the backend timeout, this is a timeout situation
    if (elapsedMs >= BACKEND_TIMEOUT_MS) {
      return { status: "timed_out", elapsedMs };
    }
    return { status: "in_progress", elapsedMs };
  }

  // Completed - return cached response
  return { status: "completed", response: state.response };
}

/**
 * Mark dispatch as completed and cache the response
 */
function markDispatchCompleted(dispatchId: string, response: string): void {
  const state = dispatchStates.get(dispatchId);
  if (state) {
    state.status = "completed";
    state.response = response;
  }
}

/**
 * Get dispatch session by dispatchId (primary method - used by tools via context.AxDispatchId)
 */
export function getDispatchSessionById(dispatchId: string): DispatchSession | undefined {
  return dispatchSessions.get(dispatchId);
}

/**
 * Get dispatch session by sessionKey (for hooks that only have sessionKey)
 * Uses secondary index for O(1) lookup instead of iterating all sessions
 */
export function getDispatchSession(sessionKey: string): DispatchSession | undefined {
  // Direct lookup by dispatchId if the key is actually a dispatchId
  if (dispatchSessions.has(sessionKey)) {
    return dispatchSessions.get(sessionKey);
  }
  // Use secondary index for sessionKey -> dispatchId lookup
  const dispatchId = sessionKeyIndex.get(sessionKey);
  if (dispatchId) {
    return dispatchSessions.get(dispatchId);
  }
  return undefined;
}

/**
 * Create the aX Platform channel plugin
 */
export function createAxChannel(config: {
  agents?: Array<{ id: string; secret: string; handle?: string; env?: string }>;
  backendUrl?: string;
}) {
  const backendUrl = config.backendUrl || process.env.AX_BACKEND_URL || "http://localhost:8001";

  // Load agent registry from config
  loadAgentRegistry(config.agents);

  return {
    id: "ax-platform",
    meta: {
      id: "ax-platform",
      label: "aX Platform",
      selectionLabel: "aX Platform (Cloud Collaboration)",
      docsPath: "/channels/ax-platform",
      blurb: "Connect to aX Platform for multi-agent collaboration",
      aliases: ["ax", "pax"],
    },

    capabilities: {
      chatTypes: ["direct", "group"],
    },

    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default" }),
    },

    outbound: {
      deliveryMode: "direct",

      // Handle agent responses - this is called by the dispatcher
      async sendText({ text, sessionKey }: { text: string; sessionKey?: string }) {
        // For aX, responses are returned via HTTP response in the dispatch handler
        // This is a no-op since we use sync-over-async pattern
        return { ok: true };
      },
    },

    // Gateway lifecycle
    gateway: {
      async start(api: { logger: { info: (msg: string) => void } }) {
        logRegisteredAgents(api.logger);
        startPeriodicCleanup();
        api.logger.info("[ax-platform] Channel started");
      },

      async stop() {
        // Clean up all state
        stopPeriodicCleanup();
        dispatchSessions.clear();
        sessionKeyIndex.clear();
        dispatchStates.clear();
      },
    },
  };
}

/**
 * Create HTTP handler for /ax/dispatch
 */
export function createDispatchHandler(
  api: {
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    config?: unknown;
  },
  config: { backendUrl?: string }
) {
  const backendUrl = config.backendUrl || "http://localhost:8001";

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // Only handle /ax/dispatch
    if (!req.url?.startsWith("/ax/dispatch")) {
      return false;
    }

    // Handle GET verification (WebSub)
    if (req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const challenge = url.searchParams.get("hub.challenge");
      if (challenge) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
        return true;
      }
      return false;
    }

    if (req.method !== "POST") {
      return false;
    }

    api.logger.info("[ax-platform] Dispatch received");

    try {
      // Read body
      api.logger.info("[ax-platform] Reading body...");
      const body = await readBody(req);
      api.logger.info(`[ax-platform] Body received (${body.length} bytes)`);

      // Peek agent_id for signature verification
      const agentIdMatch = body.match(/"agent_id"\s*:\s*"([^"]+)"/);
      const agentId = agentIdMatch?.[1];
      api.logger.info(`[ax-platform] Agent ID: ${agentId?.substring(0, 8)}...`);

      // Reject requests without agent_id
      if (!agentId) {
        api.logger.warn("[ax-platform] Missing agent_id in payload");
        sendJson(res, 400, { status: "error", dispatch_id: "unknown", error: "Missing agent_id" });
        return true;
      }

      // Reject unknown agent IDs (prevents unauthenticated dispatch)
      const agent = getAgent(agentId);
      if (!agent) {
        api.logger.warn(`[ax-platform] Unknown agent_id: ${agentId.substring(0, 8)}...`);
        sendJson(res, 401, { status: "error", dispatch_id: "unknown", error: "Unknown agent" });
        return true;
      }
      api.logger.info(`[ax-platform] Agent found: ${agent.handle || agentId.substring(0, 8)}`);

      // Verify HMAC signature (required for all dispatches)
      const signature = req.headers["x-ax-signature"] as string | undefined;
      const timestamp = req.headers["x-ax-timestamp"] as string | undefined;
      const verification = verifySignature(body, signature, timestamp, agent.secret);

      if (!verification.valid) {
        api.logger.warn(`[ax-platform] Signature failed: ${verification.error}`);
        sendJson(res, 401, { status: "error", dispatch_id: "unknown", error: verification.error });
        return true;
      }

      // Parse payload
      const payload = JSON.parse(body) as AxDispatchPayload;
      const dispatchId = payload.dispatch_id || `ext-${Date.now()}`;

      // Deduplication check - handle based on dispatch state
      const dispatchState = checkDispatchState(dispatchId);
      if (dispatchState.status === "in_progress") {
        // Retry arrived while still processing - return empty so no message is created
        const elapsedSec = Math.floor((dispatchState.elapsedMs || 0) / 1000);
        api.logger.info(`[ax-platform] Dispatch ${dispatchId} still in progress (${elapsedSec}s) - returning empty to suppress message`);
        sendJson(res, 200, {
          status: "success",
          dispatch_id: dispatchId,
          response: "", // Empty = no message created, backend keeps retrying
        } satisfies AxDispatchResponse);
        return true;
      }
      if (dispatchState.status === "timed_out") {
        // Been processing too long - this is a timeout
        const elapsedMin = Math.floor((dispatchState.elapsedMs || 0) / 60000);
        const timeoutMsg = `[Request timed out after ${elapsedMin} minutes]`;
        api.logger.error(`[ax-platform] Dispatch ${dispatchId} timed out after ${elapsedMin}m`);
        // Mark as completed so subsequent retries don't send duplicate timeout messages
        markDispatchCompleted(dispatchId, timeoutMsg);
        sendJson(res, 200, {
          status: "success",
          dispatch_id: dispatchId,
          response: timeoutMsg,
        } satisfies AxDispatchResponse);
        return true;
      }
      if (dispatchState.status === "completed") {
        // Already completed - return cached response
        api.logger.info(`[ax-platform] Dispatch ${dispatchId} already completed - returning cached response`);
        sendJson(res, 200, {
          status: "success",
          dispatch_id: dispatchId,
          response: dispatchState.response || "[Already processed]",
        } satisfies AxDispatchResponse);
        return true;
      }
      // status === "new" - proceed with processing

      // Session key for CONVERSATION CONTINUITY - based on agent + space
      // This ensures messages to the same agent in the same space share history
      const spaceId = payload.space_id || "default";
      const sessionKey = `ax-agent-${payload.agent_id}-${spaceId}`;

      // Store session context for hooks/tools - keyed by dispatchId (not sessionKey!)
      // This prevents concurrent dispatches from overwriting each other's context
      const session: DispatchSession = {
        dispatchId,
        sessionKey, // Store for reverse lookup
        agentId: payload.agent_id,
        agentHandle: payload.agent_handle || payload.agent_name || "agent",
        spaceId: payload.space_id || "",
        spaceName: payload.space_name || "aX",
        senderHandle: payload.sender_handle || "unknown",
        senderType: payload.sender_type, // "cloud_agent" | "user" | "mcp_agent"
        authToken: payload.auth_token || "",
        mcpEndpoint: payload.mcp_endpoint,
        contextData: payload.context_data,
        startTime: Date.now(),
      };
      // Log dispatch details (similar to backend's DISPATCH_PAYLOAD)
      const contextAgents = payload.context_data?.agents?.length || 0;
      const contextMessages = payload.context_data?.messages?.length || 0;
      const features = payload.feature_flags || {};
      const messagePreview = (payload.user_message || payload.content || "").substring(0, 80);
      api.logger.info(
        `[ax-platform] DISPATCH_RECEIVED ` +
        `dispatch_id=${dispatchId.substring(0, 8)} ` +
        `agent=${session.agentHandle} ` +
        `sender=@${session.senderHandle} ` +
        `sender_type=${session.senderType || 'unknown'} ` +
        `space=${session.spaceName} ` +
        `context_agents=${contextAgents} ` +
        `history=${contextMessages} ` +
        `web=${features.web_browsing ?? false} ` +
        `mcp=${features.ax_mcp ?? false} ` +
        `img=${features.image_generation ?? false}`
      );
      api.logger.info(`[ax-platform] MESSAGE: "${messagePreview}${messagePreview.length >= 80 ? '...' : ''}"`);

      // Store by dispatchId so concurrent dispatches don't overwrite each other
      dispatchSessions.set(dispatchId, session);
      // Maintain secondary index for sessionKey -> dispatchId lookup
      sessionKeyIndex.set(sessionKey, dispatchId);

      // Extract message
      const message = payload.user_message || payload.content || "";
      if (!message) {
        sendJson(res, 400, { status: "error", dispatch_id: dispatchId, error: "No message content" });
        return true;
      }

      // Send progress update
      if (payload.auth_token) {
        sendProgressUpdate(backendUrl, payload.auth_token, dispatchId, "processing", "thinking");
      }

      // Build context for the agent (identity, collaborators, recent conversation)
      const missionBriefing = buildMissionBriefing(
        session.agentHandle,
        session.spaceName,
        session.senderHandle,
        session.senderType,
        session.contextData
      );

      // Prepend mission briefing to the message so the agent sees it in context
      // This ensures the agent knows its identity even in sandboxed mode
      const messageWithContext = `${missionBriefing}\n\n---\n\n**Current Message:**\n${message}`;

      // Get runtime for agent execution
      const runtime = getAxPlatformRuntime();

      // Build context payload (matching BlueBubbles pattern)
      const ctxPayload = {
        Body: message,
        BodyForAgent: messageWithContext, // Include mission briefing in agent context
        RawBody: message,
        CommandBody: message,
        BodyForCommands: message,
        From: `ax-platform:${session.senderHandle}`,
        To: `ax-platform:${session.agentHandle}`,
        SessionKey: sessionKey,
        AccountId: "default",
        ChatType: "direct" as const,
        ConversationLabel: `${session.agentHandle} [${session.spaceName}]${agent.env ? ` (${agent.env})` : ''}`,
        SenderId: session.senderHandle,
        Provider: "ax-platform",
        Surface: "ax-platform",
        OriginatingChannel: "ax-platform",
        OriginatingTo: `ax-platform:${session.agentHandle}`,
        WasMentioned: true, // aX dispatches are always mentions
        CommandAuthorized: true,
        // aX-specific metadata
        AxDispatchId: dispatchId,
        AxSpaceId: session.spaceId,
        AxSpaceName: session.spaceName,
        AxAuthToken: session.authToken,
        AxMcpEndpoint: session.mcpEndpoint,
        // Mission briefing for context
        SystemContext: missionBriefing,
      };

      // Collect response text
      let responseText = "";
      let deliverCallCount = 0;
      let lastError: string | null = null;

      api.logger.info(`[ax-platform] Calling dispatcher for session ${sessionKey} (message=${message.length} chars, context=${missionBriefing.length} chars)`);
      const startTime = Date.now();

      // Dispatch to agent - this runs the agent and calls deliver() with response
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: api.config,
        dispatcherOptions: {
          deliver: async (deliverPayload: { text?: string; mediaUrls?: string[] }) => {
            deliverCallCount++;
            const elapsed = Date.now() - startTime;
            api.logger.info(`[ax-platform] deliver() #${deliverCallCount} at ${elapsed}ms: ${deliverPayload.text?.length || 0} chars`);
            if (deliverPayload.text) {
              responseText += deliverPayload.text;
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            const elapsed = Date.now() - startTime;
            api.logger.error(`[ax-platform] Agent error at ${elapsed}ms (${info.kind}): ${err}`);
            lastError = `${info.kind}: ${err}`;
          },
        },
      });

      const elapsed = Date.now() - startTime;
      api.logger.info(`[ax-platform] Dispatcher complete in ${elapsed}ms, deliver calls: ${deliverCallCount}, response: ${responseText.length} chars`);

      if (!responseText) {
        if (deliverCallCount === 0) {
          // Agent completed but deliver() was never called - likely early termination
          api.logger.warn(`[ax-platform] WARNING: Agent terminated without calling deliver() after ${elapsed}ms`);
          if (lastError) {
            api.logger.warn(`[ax-platform] Last error: ${lastError}`);
          }
          api.logger.warn(`[ax-platform] This may indicate the agent refused to respond or hit a stop condition`);
        } else {
          api.logger.warn(`[ax-platform] WARNING: Empty response after ${elapsed}ms and ${deliverCallCount} deliver() calls`);
        }
      }

      // Clean up dispatch context after a grace period (allows hooks/tools to complete)
      setTimeout(() => {
        dispatchSessions.delete(dispatchId);
        sessionKeyIndex.delete(sessionKey);
      }, SESSION_CLEANUP_DELAY_MS);

      // Return response with better error context
      // Note: NO_REPLY is a valid Clawdbot convention - the agent chose not to respond
      // In this case, deliver() is never called because NO_REPLY is filtered out
      let finalResponse: string;
      if (responseText) {
        finalResponse = responseText;
      } else if (lastError) {
        finalResponse = `[Agent error: ${lastError}]`;
      } else if (deliverCallCount === 0) {
        // Agent completed but nothing to deliver - NO_REPLY (intentional silence)
        // This is valid Clawdbot behavior - the agent chose not to respond
        finalResponse = "[Agent chose not to respond]";
      } else {
        finalResponse = "[No response from agent]";
      }
      // Mark dispatch as completed and cache response for retries
      markDispatchCompleted(dispatchId, finalResponse);

      api.logger.info(`[ax-platform] Sending: ${finalResponse.substring(0, LOG_PREVIEW_LENGTH)}${finalResponse.length > LOG_PREVIEW_LENGTH ? '...' : ''}`);
      sendJson(res, 200, {
        status: "success",
        dispatch_id: dispatchId,
        response: finalResponse,
      } satisfies AxDispatchResponse);

      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      api.logger.error(`[ax-platform] Dispatch error: ${errorMessage}`);

      // Clean up dispatch state on error so retries aren't incorrectly rejected
      if (typeof dispatchId !== "undefined") {
        dispatchStates.delete(dispatchId);
      }

      sendJson(res, 500, { status: "error", dispatch_id: "unknown", error: errorMessage });
      return true;
    }
  };
}

// Helpers
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
