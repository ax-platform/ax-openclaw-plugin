/**
 * aX Platform Channel Plugin
 *
 * Registers aX as a Moltbot channel for bidirectional messaging.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AxDispatchPayload, AxDispatchResponse, DispatchSession } from "../lib/types.js";
import { loadAgentRegistry, getAgent, verifySignature, logRegisteredAgents } from "../lib/auth.js";
import { sendProgressUpdate } from "../lib/api.js";

// Store active dispatch sessions (keyed by sessionKey)
const dispatchSessions = new Map<string, DispatchSession>();

// Pending response resolvers (for sync-over-async pattern)
const pendingResponses = new Map<string, {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

/**
 * Get dispatch session by sessionKey (used by bootstrap hook)
 */
export function getDispatchSession(sessionKey: string): DispatchSession | undefined {
  return dispatchSessions.get(sessionKey);
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

      // Handle agent responses - route back to aX backend
      async sendText({ text, sessionKey }: { text: string; sessionKey?: string }) {
        if (!sessionKey) return { ok: false, error: "No session key" };

        const pending = pendingResponses.get(sessionKey);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(text);
          pendingResponses.delete(sessionKey);
          return { ok: true };
        }

        return { ok: false, error: "No pending dispatch for session" };
      },
    },

    // Gateway lifecycle
    gateway: {
      async start(api: { logger: { info: (msg: string) => void } }) {
        logRegisteredAgents(api.logger);
        api.logger.info("[ax-platform] Channel started");
      },

      async stop() {
        // Clean up pending responses
        for (const [key, pending] of pendingResponses) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Channel stopped"));
          pendingResponses.delete(key);
        }
      },
    },
  };
}

/**
 * Create HTTP handler for /ax/dispatch
 */
export function createDispatchHandler(
  api: { logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void } },
  config: { backendUrl?: string },
  runAgent: (sessionKey: string, message: string) => Promise<string>
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
      const body = await readBody(req);

      // Peek agent_id for signature verification
      const agentIdMatch = body.match(/"agent_id"\s*:\s*"([^"]+)"/);
      const agentId = agentIdMatch?.[1];
      const agent = agentId ? getAgent(agentId) : undefined;

      // Verify signature if agent has secret
      if (agent?.secret) {
        const signature = req.headers["x-ax-signature"] as string | undefined;
        const timestamp = req.headers["x-ax-timestamp"] as string | undefined;
        const verification = verifySignature(body, signature, timestamp, agent.secret);

        if (!verification.valid) {
          api.logger.warn(`[ax-platform] Signature failed: ${verification.error}`);
          sendJson(res, 401, { status: "error", dispatch_id: "unknown", error: verification.error });
          return true;
        }
      }

      // Parse payload
      const payload = JSON.parse(body) as AxDispatchPayload;
      const dispatchId = payload.dispatch_id || `ext-${Date.now()}`;
      const sessionKey = `ax-agent-${payload.agent_id}`;

      // Store session context for bootstrap hook
      dispatchSessions.set(sessionKey, {
        dispatchId,
        agentId: payload.agent_id,
        agentHandle: payload.agent_handle || payload.agent_name || "agent",
        spaceId: payload.space_id || "",
        spaceName: payload.space_name || "aX",
        senderHandle: payload.sender_handle || "unknown",
        authToken: payload.auth_token || "",
        mcpEndpoint: payload.mcp_endpoint,
        contextData: payload.context_data,
        startTime: Date.now(),
      });

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

      // Run agent and wait for response (sync-over-async)
      const response = await runAgent(sessionKey, message);

      // Clean up session
      dispatchSessions.delete(sessionKey);

      // Return response
      sendJson(res, 200, {
        status: "success",
        dispatch_id: dispatchId,
        response,
      } satisfies AxDispatchResponse);

      return true;
    } catch (err) {
      api.logger.error(`[ax-platform] Dispatch error: ${err}`);
      sendJson(res, 500, { status: "error", dispatch_id: "unknown", error: String(err) });
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
