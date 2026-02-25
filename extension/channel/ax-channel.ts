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
import type { AxDispatchPayload, AxDispatchResponse, DispatchSession, OutboundConfig } from "../lib/types.js";
import { loadAgentRegistry, getAgent, verifySignature, logRegisteredAgents } from "../lib/auth.js";
import { sendProgressUpdate, callAxTool } from "../lib/api.js";
import { buildMissionBriefing } from "../lib/context.js";

// ─── Agent Event Tracking ───────────────────────────────────────────────────
// Subscribe to Clawdbot's global agent event bus for real-time tool tracking.
// This replaces the generic "Processing..." heartbeat with rich progress info.
//
// The import is dynamic because `onAgentEvent` isn't exported via plugin-sdk;
// we load it from Clawdbot's internals at runtime (same process, so it works).
// If the import fails (e.g., path changes in a future version), we fall back
// gracefully to the old behavior.
// ─────────────────────────────────────────────────────────────────────────────

type AgentEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
  seq: number;
  ts: number;
};
type AgentEventListener = (event: AgentEvent) => void;
type UnsubscribeFn = () => void;

let _onAgentEvent: ((listener: AgentEventListener) => UnsubscribeFn) | null = null;
let _agentEventsLoaded = false;

/**
 * Lazily load onAgentEvent from Clawdbot internals.
 * Returns null if unavailable (graceful degradation).
 */
async function getOnAgentEvent(): Promise<typeof _onAgentEvent> {
  if (_agentEventsLoaded) return _onAgentEvent;
  _agentEventsLoaded = true;
  try {
    // Dynamic import using absolute path to bypass package.json exports restrictions
    const mod = await import("/usr/local/lib/node_modules/clawdbot/dist/infra/agent-events.js");
    if (typeof mod.onAgentEvent === "function") {
      _onAgentEvent = mod.onAgentEvent;
    }
  } catch {
    // Not available — fall back to generic heartbeats
  }
  return _onAgentEvent;
}

// Minimum interval between event-driven heartbeats (prevents flooding)
const EVENT_HEARTBEAT_MIN_INTERVAL_MS = 3_000; // 3 seconds

// Constants
const DEDUP_TTL_MS = 15 * 60 * 1000; // 15 minutes (must exceed backend timeout of 10 min)
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 1000; // Clean up every minute
const SESSION_CLEANUP_DELAY_MS = 1000; // Grace period before session cleanup
const LOG_PREVIEW_LENGTH = 100; // Max chars to show in log previews
const RECOVERY_NOTICE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes per space

// Raw internal errors that should never be forwarded verbatim to users
const RAW_INTERNAL_ERROR_PATTERNS = {
  context: [
    "context overflow",
    "prompt too large for the model",
    "try /reset",
    "try /new",
  ],
  rate: [
    "api rate limit reached",
    "rate limit",
    "too many requests",
  ],
};

const recoveryNoticeBySpace = new Map<string, number>();

function classifyInternalErrorText(text: string): "context" | "rate" | null {
  const normalized = text.toLowerCase();
  if (RAW_INTERNAL_ERROR_PATTERNS.context.some((p) => normalized.includes(p))) {
    return "context";
  }
  if (RAW_INTERNAL_ERROR_PATTERNS.rate.some((p) => normalized.includes(p))) {
    return "rate";
  }
  return null;
}

function buildRecoveryNotice(kind: "context" | "rate"): string {
  if (kind === "context") {
    return "Quick heads up — I’m compacting internal context and will follow with a clean response shortly.";
  }
  return "Quick heads up — I hit temporary model capacity and am retrying now. I’ll send the full response shortly.";
}

// ─── Response Content Sanitizer ───────────────────────────────────────────────
// Strip reasoning/thinking blocks and system noise from agent responses before
// they are persisted as messages. Only the final answer should be visible.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip reasoning blocks, system noise, and thinking preambles from agent
 * response text so that only the final answer is persisted in the chat.
 *
 * Patterns handled:
 * 1. "Reasoning: _italic block_" at the start — strip everything before the answer
 * 2. Multi-line "Reasoning:\n_..._\n" blocks — strip the reasoning portion
 * 3. Standalone "Reasoning: _..._" that IS the entire message — extract answer after closing _
 * 4. System metadata lines (Identity, Channel, Runtime, etc.)
 * 5. OpenClaw status blocks (🦞 / 🧭)
 */
function sanitizeAgentResponse(raw: string): string {
  if (!raw) return raw;

  let text = raw;

  // 1. Strip leading "Reasoning: _..._" block followed by actual answer
  //    Pattern: starts with "Reasoning:" then italic block, then answer text
  //    e.g. "Reasoning: _I think about X_ Here is my answer"
  text = text.replace(
    /^Reasoning:\s*_[\s\S]*?_\s*/i,
    ""
  );

  // 2. Strip "Reasoning: _..._" blocks that appear mid-text (e.g. after a NO_REPLY)
  text = text.replace(
    /Reasoning:\s*_[\s\S]*?_\s*/gi,
    ""
  );

  // 3. Strip "Reasoning:" followed by non-italic content up to a double newline or end
  //    e.g. "Reasoning: I considered several approaches\n\nHere is my answer"
  text = text.replace(
    /^Reasoning:\s*[^\n]*(?:\n(?!\n)[^\n]*)*/i,
    ""
  );

  // 4. Strip 🧭 Identity blocks
  text = text.replace(
    /^🧭\s*Identity\s*\n(?:(?:Channel|User\s*id|AllowFrom|Session|Runtime|Host|Model)[^\n]*\n?)*/gim,
    ""
  );

  // 5. Strip 🦞 OpenClaw status blocks
  text = text.replace(
    /^🦞\s*OpenClaw[^\n]*(?:\n(?![\n\r])[^\n]*)*/gim,
    ""
  );

  // 6. Strip standalone system metadata lines
  text = text.replace(
    /^\s*(?:[*_`~>]+\s*)?(?:Runtime|Channel|Session|Agent|Identity|AllowFrom|User\s*id)(?:\s*[*_`~]+)?\s*:[^\n]*$/gim,
    ""
  );

  // 7. Strip toggle-only reasoning/thinking lines (e.g. "Reasoning: on")
  text = text.replace(
    /^\s*(?:[*_`~>]+\s*)?(?:Thinking|Reasoning)(?:\s*[*_`~]+)?\s*:\s*(?:[*_`~]+\s*)?(?:on|off|enabled|disabled)\s*$/gim,
    ""
  );

  // 8. Strip italic self-talk preamble
  //    Agents (especially project_lead) wrap internal monologue in _italics_
  //    before the actual answer. Find the last closing _ followed by the start
  //    of real content (uppercase, bold, heading, number) and extract the tail.
  //    Skips messages without italic preamble patterns.
  for (let i = text.length - 2; i >= 0; i--) {
    if (text[i] === "_") {
      const after = text[i + 1];
      if (/[A-Z*#\[0-9]/.test(after)) {
        const tail = text.substring(i + 1).trim();
        const before = text.substring(0, i);
        // Only extract if: substantial tail, and there's italic content before
        if (tail.length >= 10 && before.includes("_")) {
          text = tail;
          break;
        }
      }
    }
  }

  // 9. Collapse excessive newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

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

// Async dispatch callback settings
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds (rich progress)
const CALLBACK_RETRY_COUNT = 3;
const CALLBACK_RETRY_DELAY_MS = 1000; // 1 second between retries

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
 * Send heartbeat to backend callback URL
 * Returns true if successful, false otherwise
 */
async function sendHeartbeat(
  heartbeatUrl: string,
  authToken: string,
  payload: {
    agent_name?: string;
    agent_id: string;
    org_id?: string;
    message_id?: string;
    progress: string;
    percent_complete?: number;
    tokens_used?: number;
    current_tool?: string;
    elapsed_ms?: number;
  },
  logger: { info: (msg: string) => void; error: (msg: string) => void }
): Promise<boolean> {
  for (let attempt = 1; attempt <= CALLBACK_RETRY_COUNT; attempt++) {
    try {
      const response = await fetch(heartbeatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": authToken,
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        return true;
      }
      // Auth failures - abort retries immediately
      if (response.status === 401 || response.status === 403) {
        logger.error(`[ax-platform] Heartbeat auth failed (${response.status}) - aborting retries`);
        return false;
      }
      logger.error(`[ax-platform] Heartbeat failed (attempt ${attempt}): ${response.status} ${response.statusText}`);
    } catch (err) {
      logger.error(`[ax-platform] Heartbeat error (attempt ${attempt}): ${err}`);
    }
    if (attempt < CALLBACK_RETRY_COUNT) {
      await new Promise(r => setTimeout(r, CALLBACK_RETRY_DELAY_MS));
    }
  }
  return false;
}

/**
 * Send completion callback to backend
 * Returns true if successful, false otherwise
 */
async function sendCompletion(
  callbackUrl: string,
  authToken: string,
  payload: {
    agent_name?: string;
    agent_id?: string;
    org_id?: string;
    message_id?: string;
    completion_status: "success" | "failed";
    response?: string;
    error?: string;
    total_tokens?: number;
    total_tool_calls?: number;
    elapsed_ms?: number;
  },
  logger: { info: (msg: string) => void; error: (msg: string) => void }
): Promise<boolean> {
  for (let attempt = 1; attempt <= CALLBACK_RETRY_COUNT; attempt++) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": authToken,
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        logger.info(`[ax-platform] Completion callback sent successfully`);
        return true;
      }
      // Auth failures - abort retries immediately
      if (response.status === 401 || response.status === 403) {
        logger.error(`[ax-platform] Completion callback auth failed (${response.status}) - aborting retries`);
        return false;
      }
      logger.error(`[ax-platform] Completion callback failed (attempt ${attempt}): ${response.status} ${response.statusText}`);
    } catch (err) {
      logger.error(`[ax-platform] Completion callback error (attempt ${attempt}): ${err}`);
    }
    if (attempt < CALLBACK_RETRY_COUNT) {
      await new Promise(r => setTimeout(r, CALLBACK_RETRY_DELAY_MS));
    }
  }
  return false;
}

/**
 * Process dispatch asynchronously with heartbeats and completion callback
 * This is the "Stage 2" async mode that prevents Cloud Tasks timeouts
 */
async function processDispatchAsync(
  payload: AxDispatchPayload,
  session: DispatchSession,
  sessionKey: string,
  message: string,
  agent: { handle?: string; env?: string },
  api: {
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    config?: unknown;
  },
  backendUrl: string
): Promise<void> {
  const dispatchId = payload.dispatch_id || session.dispatchId;
  const startTime = Date.now();

  api.logger.info(`[ax-platform] ASYNC: Starting background processing for ${dispatchId.substring(0, 8)}`);

  // ─── Rich Heartbeat State ──────────────────────────────────────────────
  // Track agent tool execution via the global event bus so heartbeats
  // report what the agent is actually doing instead of "Processing...".
  // ───────────────────────────────────────────────────────────────────────
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatCount = 0;
  let unsubscribeEvents: UnsubscribeFn | null = null;

  // Mutable state updated by event listener, read by heartbeat timer
  let currentTool: string | null = null;
  let toolCallCount = 0;
  let lastEventHeartbeatTs = 0;

  try {
    // Try to subscribe to agent events for real-time tool tracking
    const onAgentEvent = await getOnAgentEvent();
    if (onAgentEvent) {
      api.logger.info(`[ax-platform] ASYNC: Agent event tracking enabled for session ${sessionKey}`);
      unsubscribeEvents = onAgentEvent((event: AgentEvent) => {
        // Filter to events for THIS dispatch's session only
        if (event.sessionKey !== sessionKey) return;

        if (event.stream === "tool") {
          const phase = typeof event.data.phase === "string" ? event.data.phase : "";
          const toolName = typeof event.data.name === "string" ? event.data.name : "unknown";

          if (phase === "start") {
            currentTool = toolName;
            toolCallCount++;
            api.logger.info(`[ax-platform] ASYNC: Tool started: ${toolName} (#${toolCallCount})`);

            // Send immediate heartbeat on tool start (rate-limited)
            const now = Date.now();
            if (now - lastEventHeartbeatTs >= EVENT_HEARTBEAT_MIN_INTERVAL_MS) {
              lastEventHeartbeatTs = now;
              if (payload.heartbeat_url && payload.callback_api_key) {
                sendHeartbeat(
                  payload.heartbeat_url,
                  payload.callback_api_key,
                  {
                    agent_name: session.agentHandle,
                    agent_id: session.agentId,
                    org_id: session.spaceId,
                    message_id: payload.message_id,
                    progress: `Using ${toolName}...`,
                    current_tool: toolName,
                    elapsed_ms: now - startTime,
                  },
                  api.logger
                ).catch(() => {}); // Fire-and-forget
              }
            }
          } else if (phase === "end") {
            currentTool = null;
          }
        }
      });
    } else {
      api.logger.info(`[ax-platform] ASYNC: Agent event tracking unavailable — using generic heartbeats`);
    }

    // Start periodic heartbeat timer (enriched with tool info when available)
    heartbeatTimer = setInterval(async () => {
      heartbeatCount++;
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = Math.round(elapsedMs / 1000);

      // Build rich progress string
      let progress: string;
      if (currentTool) {
        progress = `Using ${currentTool}... (${elapsedSec}s)`;
      } else if (toolCallCount > 0) {
        progress = `Thinking... (${toolCallCount} tool${toolCallCount > 1 ? 's' : ''} used, ${elapsedSec}s)`;
      } else {
        progress = `Processing... (${elapsedSec}s)`;
      }

      api.logger.info(`[ax-platform] ASYNC: Heartbeat #${heartbeatCount}: ${progress}`);

      if (payload.heartbeat_url && payload.callback_api_key) {
        await sendHeartbeat(
          payload.heartbeat_url,
          payload.callback_api_key,
          {
            agent_name: session.agentHandle,
            agent_id: session.agentId,
            org_id: session.spaceId,
            message_id: payload.message_id,
            progress,
            current_tool: currentTool || undefined,
            elapsed_ms: elapsedMs,
          },
          api.logger
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Build context payload
    const asyncAgentHandle = (session.agentHandle || "agent").replace(/^@/, "");
    const ctxPayload = {
      Body: message,
      BodyForAgent: message,
      RawBody: message,
      CommandBody: message,
      BodyForCommands: message,
      From: `ax-platform:${session.senderHandle}`,
      To: `ax-platform:${session.agentHandle}`,
      SessionKey: sessionKey,
      AccountId: asyncAgentHandle,
      ChatType: "direct" as const,
      ConversationLabel: `${session.agentHandle} [${session.spaceName}]${agent.env ? ` (${agent.env})` : ''}`,
      SenderId: session.senderHandle,
      Provider: "ax-platform",
      Surface: "ax-platform",
      OriginatingChannel: "ax-platform",
      OriginatingTo: `ax-platform:${session.agentHandle}`,
      WasMentioned: true,
      CommandAuthorized: true,
      AxDispatchId: dispatchId,
      AxSpaceId: session.spaceId,
      AxSpaceName: session.spaceName,
      AxAuthToken: session.authToken,
      AxMcpEndpoint: session.mcpEndpoint,
    };

    // Collect response
    let responseText = "";
    let deliverCallCount = 0;
    let lastError: string | null = null;

    const runtime = getAxPlatformRuntime();

    // Dispatch to agent — use top-level config for proper agent resolution
    const asyncTopConfig = (runtime as any).config.loadConfig();
    api.logger.info(`[ax-platform] ASYNC: Dispatching with top-level config (agents=${asyncTopConfig?.agents?.list?.length || 0}, bindings=${asyncTopConfig?.bindings?.length || 0})`);
    try {
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: asyncTopConfig,
        dispatcherOptions: {
          deliver: async (deliverPayload: { text?: string; mediaUrls?: string[] }) => {
            deliverCallCount++;
            const elapsed = Date.now() - startTime;
            api.logger.info(`[ax-platform] ASYNC: deliver() #${deliverCallCount} at ${elapsed}ms: ${deliverPayload.text?.length || 0} chars`);
            if (deliverPayload.text) {
              responseText += deliverPayload.text;
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            api.logger.error(`[ax-platform] ASYNC: Agent error (${info.kind}): ${err}`);
            lastError = `${info.kind}: ${err}`;
          },
        },
      });
    } catch (err) {
      api.logger.error(`[ax-platform] ASYNC: Dispatch threw: ${err}`);
      lastError = String(err);
    }

    const elapsed = Date.now() - startTime;
    api.logger.info(`[ax-platform] ASYNC: Processing complete in ${elapsed}ms, deliver calls: ${deliverCallCount}, response: ${responseText.length} chars`);

    // Determine final response
    let finalResponse: string;
    let completionStatus: "success" | "failed" = "success";

    if (responseText) {
      finalResponse = sanitizeAgentResponse(responseText);
    } else if (lastError) {
      finalResponse = `[Agent error: ${lastError}]`;
      completionStatus = "failed";
    } else if (deliverCallCount === 0) {
      finalResponse = "[Agent chose not to respond]";
    } else {
      finalResponse = "[No response from agent]";
    }

    // Mark dispatch as completed
    markDispatchCompleted(dispatchId, finalResponse);

    // Send completion callback (with tool stats)
    if (payload.callback_url && payload.callback_api_key) {
      api.logger.info(`[ax-platform] ASYNC: Sending completion callback (${toolCallCount} tool calls)`);
      await sendCompletion(
        payload.callback_url,
        payload.callback_api_key,
        {
          agent_name: payload.agent_name || payload.agent_handle,
          agent_id: payload.agent_id,
          org_id: payload.org_id || payload.space_id || session.spaceId,
          message_id: payload.message_id,
          completion_status: completionStatus,
          response: finalResponse,
          error: lastError || undefined,
          total_tool_calls: toolCallCount,
          elapsed_ms: elapsed,
        },
        api.logger
      );
    } else {
      api.logger.warn(`[ax-platform] ASYNC: CRITICAL - No callback_url or callback_api_key, response will be lost!`);
    }

    // Clean up session (only delete index if it still points to this dispatch)
    setTimeout(() => {
      dispatchSessions.delete(dispatchId);
      if (sessionKeyIndex.get(sessionKey) === dispatchId) {
        sessionKeyIndex.delete(sessionKey);
      }
    }, SESSION_CLEANUP_DELAY_MS);
  } finally {
    // Always clean up heartbeat timer and event subscription
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (unsubscribeEvents) {
      unsubscribeEvents();
      api.logger.info(`[ax-platform] ASYNC: Unsubscribed from agent events (${toolCallCount} tool calls tracked)`);
    }
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
 * Resolve auth token for outbound delivery.
 * Tries tokenFile first, then AX_ACCESS_TOKEN env var.
 */
async function resolveOutboundToken(outboundCfg: OutboundConfig | Record<string, unknown>): Promise<string | undefined> {
  const cfg = outboundCfg || {};
  const tokenFile = (cfg as OutboundConfig).tokenFile;

  if (tokenFile) {
    try {
      const fs = await import("node:fs");
      const tokenPath = tokenFile.replace(/^~/, process.env.HOME || "");
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
      if (tokenData.access_token) return tokenData.access_token;
    } catch {
      // Fall through to env var
    }
  }

  return process.env.AX_ACCESS_TOKEN;
}

/**
 * Create the aX Platform channel plugin
 */
export function createAxChannel(config: {
  outbound?: OutboundConfig;
  agents?: Array<{ id: string; secret: string; handle?: string; env?: string }>;
  backendUrl?: string;
}) {
  const backendUrl = config.backendUrl || process.env.AX_BACKEND_URL || "http://localhost:8001";
  const outboundConfig = config.outbound || {};

  // Load agent registry from config
  loadAgentRegistry(config.agents);

  // Probe cache — one MCP call covers all prod accounts
  let probeCache: { result: any; ts: number } | null = null;

  // Helper: get agents array from clawdbot config
  function getPluginAgents(cfg: any): Array<{ id: string; secret: string; handle?: string; env?: string }> {
    const pluginAgents = cfg?.plugins?.entries?.["ax-platform"]?.config?.agents;
    if (Array.isArray(pluginAgents) && pluginAgents.length > 0) {
      return pluginAgents;
    }
    return config.agents || [];
  }

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
      media: { images: true, documents: true },
      threads: true,
      mentions: true,
    },

    config: {
      /**
       * List all configured account IDs
       */
      listAccountIds: (cfg: any) => {
        return getPluginAgents(cfg).map((a) => a.handle?.replace(/^@/, "") || a.id);
      },

      /**
       * Default account ID - first prod agent, or first agent
       */
      defaultAccountId: (cfg: any) => {
        const agents = getPluginAgents(cfg);
        const prod = agents.find((a) => a.env === "prod");
        const agent = prod || agents[0];
        return agent ? (agent.handle?.replace(/^@/, "") || agent.id) : "default";
      },

      /**
       * Check if account is enabled
       */
      isEnabled: (account: any) => account?.enabled !== false,

      /**
       * Check if account has required credentials
       */
      isConfigured: (account: any) => Boolean(account?.agentId && account?.secret),

      /**
       * Describe account for dashboard listing
       */
      describeAccount: (account: any) => ({
        accountId: account?.accountId || "default",
        name: account?.handle ? `@${account.handle.replace(/^@/, "")}` : account?.accountId,
        enabled: account?.enabled !== false,
        configured: Boolean(account?.agentId && account?.secret),
      }),

      /**
       * Resolve account config by ID
       */
      resolveAccount: (cfg: any, accountId?: string) => {
        const agents = getPluginAgents(cfg);
        const agent = agents.find((a) =>
          a.handle?.replace(/^@/, "") === accountId ||
          a.id === accountId
        ) || (accountId ? undefined : agents[0]);

        if (agent) {
          return {
            accountId: agent.handle?.replace(/^@/, "") || agent.id,
            agentId: agent.id,
            secret: agent.secret,
            handle: agent.handle,
            enabled: true,
            env: agent.env,
          };
        }

        return { accountId: accountId || "default" };
      },
    },

    outbound: {
      deliveryMode: "direct" as const,
      chunker: null,
      textChunkLimit: 4000,

      /**
       * Send text to aX Platform (for heartbeat/cron delivery)
       * Matches Clawdbot's standard channel outbound interface
       */
      async sendText({
        to,
        text,
        accountId,
        cfg,
        replyToId,
        threadId,
        deps,
      }: {
        to: string;
        text: string;
        accountId?: string;
        cfg?: any;
        replyToId?: string;
        threadId?: string;
        deps?: any;
      }) {
        const logger = runtime?.logger || { info: console.log, error: console.error };

        const authToken = await resolveOutboundToken(outboundConfig);
        if (!authToken) {
          logger.error("[ax-platform] Outbound sendText failed: No access token configured");
          return { channel: "ax-platform", ok: false, error: "No access token" };
        }

        const outboundCfg = outboundConfig || {};
        const mcpEndpoint = outboundCfg.mcpEndpoint || process.env.AX_MCP_ENDPOINT || "https://mcp.paxai.app";
        const spaceId = to?.replace(/^space:/, "") || outboundCfg.defaultSpaceId;
        if (!spaceId) {
          logger.error("[ax-platform] Outbound sendText failed: No target space");
          return { channel: "ax-platform", ok: false, error: "No target space" };
        }

        let outboundText = text || "";
        const internalErrorKind = classifyInternalErrorText(outboundText);
        if (internalErrorKind) {
          const now = Date.now();
          const lastNoticeAt = recoveryNoticeBySpace.get(spaceId) || 0;
          if (now - lastNoticeAt < RECOVERY_NOTICE_COOLDOWN_MS) {
            logger.info(`[ax-platform] Suppressing duplicate internal error notice (${internalErrorKind}) for ${spaceId}`);
            return { channel: "ax-platform", ok: true, suppressed: true };
          }

          outboundText = buildRecoveryNotice(internalErrorKind);
          recoveryNoticeBySpace.set(spaceId, now);
          logger.info(`[ax-platform] Replaced raw internal error text with graceful recovery notice (${internalErrorKind})`);
        }

        // Sanitize outbound text (strip reasoning blocks, system noise, identity blocks)
        outboundText = sanitizeAgentResponse(outboundText);

        try {
          const result = await callAxTool(mcpEndpoint, authToken, "messages", {
            action: "send",
            content: outboundText,
            space_id: spaceId,
          }) as Record<string, unknown>;

          const preview = outboundText.length > 50 ? outboundText.substring(0, 50) + "..." : outboundText;
          logger.info(`[ax-platform] Outbound sent to ${spaceId}: ${preview}`);
          return { channel: "ax-platform", ok: true, messageId: result.message_id };
        } catch (err) {
          logger.error(`[ax-platform] Outbound sendText error: ${err}`);
          return { channel: "ax-platform", ok: false, error: String(err) };
        }
      },

      /**
       * Send media to aX Platform (for heartbeat/cron delivery)
       * Matches Clawdbot's standard channel outbound interface
       */
      async sendMedia({
        to,
        text,
        mediaUrl,
        accountId,
        cfg,
        replyToId,
        threadId,
        deps,
      }: {
        to: string;
        text?: string;
        mediaUrl: string;
        accountId?: string;
        cfg?: any;
        replyToId?: string;
        threadId?: string;
        deps?: any;
      }) {
        const logger = runtime?.logger || { info: console.log, error: console.error };

        const authToken = await resolveOutboundToken(outboundConfig);
        if (!authToken) {
          logger.error("[ax-platform] Outbound sendMedia failed: No access token configured");
          return { channel: "ax-platform", ok: false, error: "No access token" };
        }

        const outboundCfg = outboundConfig || {};
        const mcpEndpoint = outboundCfg.mcpEndpoint || process.env.AX_MCP_ENDPOINT || "https://mcp.paxai.app";
        const spaceId = to?.replace(/^space:/, "") || outboundCfg.defaultSpaceId;
        if (!spaceId) {
          logger.error("[ax-platform] Outbound sendMedia failed: No target space");
          return { channel: "ax-platform", ok: false, error: "No target space" };
        }

        try {
          const content = text ? `${text}\n\n${mediaUrl}` : mediaUrl;
          const result = await callAxTool(mcpEndpoint, authToken, "messages", {
            action: "send",
            content,
            space_id: spaceId,
          }) as Record<string, unknown>;

          logger.info(`[ax-platform] Outbound media sent to ${spaceId}: ${mediaUrl}`);
          return { channel: "ax-platform", ok: true, messageId: result.message_id };
        } catch (err) {
          logger.error(`[ax-platform] Outbound sendMedia error: ${err}`);
          return { channel: "ax-platform", ok: false, error: String(err) };
        }
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

    // Status adapter for dashboard health checks
    status: {
      defaultRuntime: {
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },

      buildAccountSnapshot: ({ account, runtime, probe, audit }: {
        account: any; cfg?: any; runtime?: any; probe?: any; audit?: any;
      }) => ({
        accountId: account?.accountId || "default",
        name: account?.handle ? `@${account.handle.replace(/^@/, "")}` : account?.accountId,
        enabled: account?.enabled !== false,
        configured: Boolean(account?.agentId && account?.secret),
        running: runtime?.running ?? false,
        connected: probe?.ok ?? undefined,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        mode: "webhook",
        probe,
        audit,
      }),

      buildChannelSummary: ({ snapshot }: { snapshot: any; account?: any; cfg?: any; defaultAccountId?: string }) => ({
        configured: snapshot?.configured ?? false,
        running: snapshot?.running ?? false,
        lastError: snapshot?.lastError ?? null,
      }),

      probeAccount: async ({ account, timeoutMs }: { account: any; timeoutMs: number; cfg?: any }) => {
        if (!account?.agentId || !account?.secret) {
          return { ok: false, error: "Missing agentId or secret" };
        }

        // Only probe prod agents against paxai.app
        if (account.env && account.env !== "prod") {
          return { ok: true, mode: "local", skipped: true };
        }

        const token = await resolveOutboundToken(outboundConfig);
        if (!token) {
          return { ok: false, error: "No access token for outbound" };
        }

        // Reuse cached probe if fresh (within 60s) — avoids N calls per status refresh
        if (probeCache && Date.now() - probeCache.ts < 60000) {
          return probeCache.result;
        }

        const mcpEndpoint = (outboundConfig as OutboundConfig).mcpEndpoint
          || process.env.AX_MCP_ENDPOINT || "https://mcp.paxai.app";
        const handle = account.handle?.replace(/^@/, "") || account.accountId;

        try {
          const data = await callAxTool(mcpEndpoint, token, "agents", {
            search: handle,
            limit: 1,
          }) as any;
          const found = Array.isArray(data?.agents) && data.agents.length > 0;
          const result = { ok: true, mode: "webhook", agentFound: found, handle: `@${handle}` };
          probeCache = { result, ts: Date.now() };
          return result;
        } catch (err: any) {
          const result = { ok: false, error: String(err) };
          probeCache = { result, ts: Date.now() };
          return result;
        }
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
  const outboundConfig = config.outbound || {};

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

      // Resolve agent route using Clawdbot's native routing system
      // This matches our bindings config to route each aX agent to its own workspace
      const spaceId = payload.space_id || "default";
      const agentHandle = (agent.handle || "agent").replace(/^@/, "");
      const routeRuntime = getAxPlatformRuntime();
      const topLevelConfig = (routeRuntime as any).config.loadConfig();

      const route = (routeRuntime as any).channel.routing.resolveAgentRoute({
        cfg: topLevelConfig,
        channel: "ax-platform",
        accountId: agentHandle,
        peer: { kind: "dm", id: payload.sender_handle || "unknown" },
      });

      const sessionKey = route.sessionKey;
      api.logger.info(`[ax-platform] ROUTE: agent=${agentHandle} -> clawdbot_agent=${route.agentId} session=${sessionKey} matched_by=${route.matchedBy || 'default'}`);

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

      // ============================================================
      // ASYNC MODE: If callback_url is present, ACK immediately and
      // process in background. This prevents Cloud Tasks timeouts.
      // ============================================================
      if (payload.callback_url) {
        api.logger.info(`[ax-platform] ASYNC MODE: callback_url detected, ACKing immediately`);

        // ACK immediately to Cloud Tasks
        sendJson(res, 200, {
          status: "accepted",
          dispatch_id: dispatchId,
          mode: "async"
        });

        // Process in background (fire and forget)
        processDispatchAsync(
          payload,
          session,
          sessionKey,
          message,
          agent,
          api,
          backendUrl
        ).catch(err => {
          api.logger.error(`[ax-platform] Async dispatch failed: ${err}`);
          // Mark as completed to prevent infinite retries
          markDispatchCompleted(dispatchId, `[System error: ${err}]`);
          // Attempt to send failure callback
          if (payload.callback_url && payload.callback_api_key) {
            sendCompletion(
              payload.callback_url,
              payload.callback_api_key,
              {
                agent_name: payload.agent_name || payload.agent_handle,
                agent_id: payload.agent_id,
                org_id: payload.org_id || payload.space_id || session.spaceId,
                message_id: payload.message_id,
                completion_status: "failed",
                error: String(err),
              },
              api.logger
            ).catch(callbackErr => {
              api.logger.error(`[ax-platform] Failed to send error callback: ${callbackErr}`);
            });
          }
        });

        return true;
      }
      // ============================================================
      // SYNC MODE: Fallback for backends without callback_url
      // (backward compatible with existing behavior)
      // ============================================================

      // Send progress update
      if (payload.auth_token) {
        sendProgressUpdate(backendUrl, payload.auth_token, dispatchId, "processing", "thinking");
      }

      // Get runtime for agent execution
      const runtime = getAxPlatformRuntime();

      // Build context payload (matching BlueBubbles pattern)
      const ctxPayload = {
        Body: message,
        BodyForAgent: message,
        RawBody: message,
        CommandBody: message,
        BodyForCommands: message,
        From: `ax-platform:${session.senderHandle}`,
        To: `ax-platform:${session.agentHandle}`,
        SessionKey: sessionKey,
        AccountId: session.agentHandle?.replace('@', '') || "default",
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
      };

      // Collect response text
      let responseText = "";
      let deliverCallCount = 0;
      let lastError: string | null = null;

      api.logger.info(`[ax-platform] Calling dispatcher for session ${sessionKey} (message=${message.length} chars)`);
      const startTime = Date.now();

      // Dispatch to agent — use top-level config for proper agent resolution
      const syncTopConfig = (runtime as any).config.loadConfig();
      api.logger.info(`[ax-platform] SYNC: Dispatching with top-level config (agents=${syncTopConfig?.agents?.list?.length || 0}, bindings=${syncTopConfig?.bindings?.length || 0})`);

      try {
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: syncTopConfig,
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
      } catch (dispatchErr) {
        api.logger.error(`[ax-platform] Dispatch threw: ${dispatchErr}`);
        throw dispatchErr;
      }

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
        if (sessionKeyIndex.get(sessionKey) === dispatchId) {
          sessionKeyIndex.delete(sessionKey);
        }
      }, SESSION_CLEANUP_DELAY_MS);

      // Return response with better error context
      // Note: NO_REPLY is a valid Clawdbot convention - the agent chose not to respond
      // In this case, deliver() is never called because NO_REPLY is filtered out
      let finalResponse: string;
      if (responseText) {
        finalResponse = sanitizeAgentResponse(responseText);
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
const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
