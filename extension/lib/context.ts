/**
 * Build mission briefing context from dispatch payload
 *
 * Optimized for minimal token usage (<500 tokens target).
 * Conversation history is NOT included here — Clawdbot's native session
 * history handles that. This briefing only provides aX-specific context
 * that Clawdbot doesn't know: identity, collaborators, and sender info.
 */

import type { ContextData } from "./types.js";

const DEFAULT_CONFIG = {
  maxAgentDescChars: 80,
  maxAgents: 8,
};

/**
 * Build mission briefing markdown from context data
 * This will be injected via before_agent_start hook using prependContext
 *
 * Kept lean: identity + collaborators + sender type only.
 * Conversation history is handled by Clawdbot's native session context.
 */
export function buildMissionBriefing(
  agentHandle: string,
  spaceName: string,
  senderHandle: string,
  senderType?: string,
  contextData?: ContextData,
  config = DEFAULT_CONFIG
): string {
  const lines: string[] = [];

  // Identity (essential — agent must know who it is on aX)
  lines.push("# aX Platform Context");
  lines.push(`You ARE ${agentHandle} in space "${spaceName}".`);
  lines.push(`Message from: @${senderHandle}${senderType ? ` (${senderType})` : ""}`);
  if (senderType === "mcp_agent") {
    lines.push(`MCP agents require @mention to receive your response.`);
  }
  lines.push("");

  // Collaborators (so agent knows who else is available)
  if (contextData?.agents && contextData.agents.length > 0) {
    const otherAgents = contextData.agents.filter(agent => {
      const handle = `@${agent.name}`;
      return handle !== agentHandle && agent.name !== agentHandle.replace("@", "");
    });

    if (otherAgents.length > 0) {
      lines.push("## Agents in Space");
      const displayed = otherAgents.slice(0, config.maxAgents);
      for (const agent of displayed) {
        let desc = "";
        if (agent.description) {
          desc = agent.description.length > config.maxAgentDescChars
            ? ` - ${agent.description.substring(0, config.maxAgentDescChars)}...`
            : ` - ${agent.description}`;
        }
        lines.push(`- @${agent.name}${desc}`);
      }
      const omitted = otherAgents.length - displayed.length;
      if (omitted > 0) {
        lines.push(`- (${omitted} more)`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Estimate token count for context (rough approximation)
 */
export function estimateContextTokens(context: string): number {
  return Math.ceil(context.length / 4);
}

/**
 * Compact briefing alias — now identical to buildMissionBriefing since
 * the standard briefing is already minimal.
 */
export function buildCompactMissionBriefing(
  agentHandle: string,
  spaceName: string,
  senderHandle: string,
  senderType?: string,
  contextData?: ContextData
): string {
  return buildMissionBriefing(agentHandle, spaceName, senderHandle, senderType, contextData);
}
