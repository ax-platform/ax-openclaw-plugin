/**
 * Build mission briefing context from dispatch payload
 * 
 * Design principles (by @clawdbot_cipher, first webhook agent):
 * 1. Recent messages should be COMPLETE - no truncation for the last few
 * 2. Older messages can be summarized but shouldn't disappear silently
 * 3. Agents should know when context was trimmed
 * 4. Message IDs enable fetching full content if needed
 * 5. Think about the NEXT webhook agent - make this experience fluid
 */

import type { ContextData, Message } from "./types.js";

// Configuration - can be overridden per-agent in the future
// NOTE (2026-02-19): Reduced history window to prevent context overflow in active threads.
// Group threads with many long agent messages were pushing the injected context over
// the model's limit even on fresh sessions (since history is re-injected per message).
// Previous: 5+15=20 messages. Current: 3+7=10 messages.
const DEFAULT_CONFIG = {
  // How many recent messages to include at full length
  fullLengthMessages: 3,
  // How many additional messages to include (truncated)
  additionalMessages: 7,
  // Max chars for truncated messages (older ones in the window)
  truncatedMaxChars: 400,
  // Max chars for full-length messages (most recent)
  fullMaxChars: 1500,
  // Max agent descriptions
  maxAgentDescChars: 120,
  // Max agents to show
  maxAgents: 15,
};

// When truncating, try to break at word boundary if we're past this ratio
const WORD_BOUNDARY_THRESHOLD = 0.8;

// Fallback for empty message content
const EMPTY_MESSAGE_FALLBACK = "(empty message)";

/**
 * Format a single message for the context
 */
function formatMessage(
  msg: Message,
  maxChars: number,
  includeTimestamp: boolean = false
): string {
  const authorIcon = msg.author_type === "agent" ? "🤖" : "👤";
  const timestamp = includeTimestamp && msg.timestamp 
    ? ` (${formatRelativeTime(msg.timestamp)})` 
    : "";
  
  // Handle empty or missing content
  let content = msg.content?.trim() || EMPTY_MESSAGE_FALLBACK;
  
  if (content.length > maxChars) {
    content = content.substring(0, maxChars).trim();
    // Try to break at a word boundary if we're past the threshold
    const lastSpace = content.lastIndexOf(" ");
    if (lastSpace > maxChars * WORD_BOUNDARY_THRESHOLD) {
      content = content.substring(0, lastSpace);
    }
    content += " [...]";
  }
  
  // Preserve line breaks but collapse excessive whitespace
  content = content.replace(/\n{3,}/g, "\n\n");
  
  return `${authorIcon} **@${msg.author}**${timestamp}: ${content}`;
}

/**
 * Format relative time from ISO timestamp
 */
function formatRelativeTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch (err) {
    console.warn(`[ax-platform] Failed to parse timestamp "${isoTimestamp}":`, err);
    return "";
  }
}

/**
 * Build mission briefing markdown from context data
 * This will be injected via before_agent_start hook using prependContext
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

  // ═══════════════════════════════════════════════════════════════════════════
  // IDENTITY SECTION
  // ═══════════════════════════════════════════════════════════════════════════
  lines.push("# aX Platform Context");
  lines.push("");
  lines.push("## Your Identity");
  lines.push(`**IMPORTANT: You ARE ${agentHandle}.**`);
  lines.push(`When someone @mentions ${agentHandle}, they are talking to YOU. You must respond.`);
  lines.push(`When you see messages addressed to ${agentHandle}, those messages are FOR YOU.`);
  lines.push("");
  lines.push(`- **Your handle:** ${agentHandle}`);
  lines.push(`- **Current space:** ${spaceName}`);
  lines.push(`- **Message from:** @${senderHandle}`);
  lines.push("");

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLABORATORS SECTION
  // ═══════════════════════════════════════════════════════════════════════════
  if (contextData?.agents && contextData.agents.length > 0) {
    lines.push("## Other Agents in This Space");
    lines.push("These are OTHER agents you can @mention to collaborate with:");
    
    // Filter out self first, then slice
    const otherAgents = contextData.agents.filter(agent => {
      const handle = `@${agent.name}`;
      return handle !== agentHandle && agent.name !== agentHandle.replace("@", "");
    });
    
    const displayedAgents = otherAgents.slice(0, config.maxAgents);
    
    for (const agent of displayedAgents) {
      const typeIcon = agent.type === "sentinel" ? "🛡️" 
        : agent.type === "assistant" ? "🤖" 
        : "👤";
      
      let desc = "";
      if (agent.description) {
        desc = agent.description.length > config.maxAgentDescChars
          ? ` - ${agent.description.substring(0, config.maxAgentDescChars)}...`
          : ` - ${agent.description}`;
      }
      lines.push(`- @${agent.name} ${typeIcon}${desc}`);
    }
    
    // Note if agents were omitted - use filtered array length
    const omittedCount = otherAgents.length - displayedAgents.length;
    if (omittedCount > 0) {
      lines.push(`- *(${omittedCount} more agents in space)*`);
    }
    lines.push("");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATION HISTORY SECTION
  // ═══════════════════════════════════════════════════════════════════════════
  if (contextData?.messages && contextData.messages.length > 0) {
    lines.push("## Recent Conversation");
    
    const allMessages = contextData.messages;
    const totalMessages = allMessages.length;
    const windowSize = config.fullLengthMessages + config.additionalMessages;
    
    // If we have more messages than our window, note what's missing
    if (totalMessages > windowSize) {
      const droppedCount = totalMessages - windowSize;
      lines.push(`*(${droppedCount} earlier messages not shown)*`);
      lines.push("");
    }
    
    // Take the messages we'll display
    const displayMessages = allMessages.slice(-windowSize);
    
    // Split into truncated (older) and full-length (recent)
    const truncatedMessages = displayMessages.slice(0, -config.fullLengthMessages);
    const recentMessages = displayMessages.slice(-config.fullLengthMessages);
    
    // Render truncated messages (older context)
    if (truncatedMessages.length > 0) {
      lines.push("### Earlier in Thread");
      for (const msg of truncatedMessages) {
        lines.push(formatMessage(msg, config.truncatedMaxChars, true));
      }
      lines.push("");
    }
    
    // Render recent messages (full length)
    if (recentMessages.length > 0) {
      if (truncatedMessages.length > 0) {
        lines.push("### Recent Messages");
      }
      for (const msg of recentMessages) {
        lines.push(formatMessage(msg, config.fullMaxChars, true));
      }
      lines.push("");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CURRENT MESSAGE SECTION
  // ═══════════════════════════════════════════════════════════════════════════
  lines.push("## This Message");
  
  // Sender type context for protocol decisions
  if (senderType === "mcp_agent") {
    lines.push(`From: @${senderHandle} (mcp_agent)`);
    lines.push(`*→ MCP agents require @mention to receive your response*`);
  } else if (senderType === "cloud_agent") {
    lines.push(`From: @${senderHandle} (cloud_agent)`);
    lines.push(`*→ Cloud agents see all messages in space*`);
  } else {
    lines.push(`From: @${senderHandle} (user)`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Estimate token count for context (rough approximation)
 * Useful for future token budget management
 */
export function estimateContextTokens(context: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(context.length / 4);
}

/**
 * Build a compact context for token-constrained situations
 */
export function buildCompactMissionBriefing(
  agentHandle: string,
  spaceName: string,
  senderHandle: string,
  senderType?: string,
  contextData?: ContextData
): string {
  return buildMissionBriefing(
    agentHandle,
    spaceName,
    senderHandle,
    senderType,
    contextData,
    {
      fullLengthMessages: 3,
      additionalMessages: 5,
      truncatedMaxChars: 200,
      fullMaxChars: 800,
      maxAgentDescChars: 60,
      maxAgents: 8,
    }
  );
}
