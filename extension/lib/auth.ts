/**
 * Authentication and agent registry for ax-platform plugin
 */

import * as crypto from "node:crypto";
import type { AgentEntry } from "./types.js";

// Agent registry loaded from config
let agentRegistry: Map<string, AgentEntry> | null = null;

/**
 * Load agent registry from plugin config
 */
export function loadAgentRegistry(agents: AgentEntry[] | undefined): Map<string, AgentEntry> {
  if (agentRegistry) return agentRegistry;

  agentRegistry = new Map();

  if (agents) {
    for (const agent of agents) {
      if (agent.id && agent.secret) {
        agentRegistry.set(agent.id, agent);
      }
    }
  }

  // Fallback to env vars for single-agent setup
  const envId = process.env.AX_AGENT_ID;
  const envSecret = process.env.AX_WEBHOOK_SECRET;
  if (envId && envSecret && !agentRegistry.has(envId)) {
    agentRegistry.set(envId, { id: envId, secret: envSecret, env: "default" });
  }

  return agentRegistry;
}

/**
 * Get agent entry by ID
 */
export function getAgent(agentId: string): AgentEntry | undefined {
  return agentRegistry?.get(agentId);
}

/**
 * Verify HMAC signature
 */
export function verifySignature(
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string
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

/**
 * Log registered agents (for startup diagnostics)
 */
export function logRegisteredAgents(logger: { info: (msg: string) => void }): void {
  if (!agentRegistry || agentRegistry.size === 0) {
    logger.info("[ax-platform] No agents configured");
    return;
  }

  logger.info(`[ax-platform] Registered agents (${agentRegistry.size}):`);
  for (const [id, agent] of agentRegistry) {
    const handle = agent.handle || "(no handle)";
    const env = agent.env || "(no env)";
    logger.info(`[ax-platform]   ${handle} [${env}] -> ${id.substring(0, 8)}...`);
  }
}
