/**
 * ax_thread tool - Retrieve full message content and thread context
 * 
 * When message truncation loses important details, agents can use this
 * to fetch complete message content or expand thread history.
 */

import { Type } from "@sinclair/typebox";
import { callAxTool } from "../lib/api.js";
import { getDispatchSession } from "../channel/ax-channel.js";

// Maximum response size before truncation (50KB)
const MAX_RESPONSE_SIZE = 50 * 1024;

/**
 * Truncate response if it exceeds max size
 */
function truncateResponse(result: unknown): { data: string; truncated: boolean } {
  const json = JSON.stringify(result, null, 2);
  
  if (json.length <= MAX_RESPONSE_SIZE) {
    return { data: json, truncated: false };
  }
  
  // Truncate with warning
  const truncated = json.substring(0, MAX_RESPONSE_SIZE);
  const warning = `\n\n[Response truncated: ${json.length} chars exceeded ${MAX_RESPONSE_SIZE} limit]`;
  
  return { 
    data: truncated + warning, 
    truncated: true 
  };
}

export const axThreadTool = {
  name: "ax_thread",
  description: `Retrieve full message content or expand thread history. Use when:
- A message was truncated ([...]) and you need the complete text
- You need to see older messages not in your current context
- You want to understand thread flow before a certain point`,
  
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("get_message"),
      Type.Literal("get_history"),
      Type.Literal("get_context"),
    ], {
      description: "Action: get_message (full text), get_history (older messages), get_context (thread summary)",
    }),
    message_id: Type.Optional(Type.String({ 
      description: "Message ID to retrieve (for get_message)" 
    })),
    before_timestamp: Type.Optional(Type.String({ 
      description: "ISO timestamp - get messages before this time (for get_history)" 
    })),
    limit: Type.Optional(Type.Number({ 
      description: "Max messages to return (for get_history)", 
      default: 10 
    })),
  }),

  async execute(_toolCallId: string, params: Record<string, unknown>, context: { sessionKey?: string }) {
    const sessionKey = context.sessionKey;
    const session = sessionKey ? getDispatchSession(sessionKey) : undefined;

    if (!session?.authToken || !session?.mcpEndpoint) {
      return { 
        content: [{ 
          type: "text", 
          text: "Error: No aX session context available. This tool only works during active dispatches." 
        }] 
      };
    }

    try {
      const result = await callAxTool(session.mcpEndpoint, session.authToken, "thread", params);
      
      // Validate and potentially truncate response size
      const { data, truncated } = truncateResponse(result);
      
      if (truncated) {
        console.warn(`[ax-platform] ax_thread response truncated: original size exceeded ${MAX_RESPONSE_SIZE} bytes`);
      }
      
      return { content: [{ type: "text", text: data }] };
    } catch (err) {
      // If the backend doesn't support this yet, provide helpful feedback
      const errorMsg = String(err);
      if (errorMsg.includes("404") || errorMsg.includes("not found")) {
        return { 
          content: [{ 
            type: "text", 
            text: "Note: The ax_thread tool requires backend support that may not be deployed yet. " +
                  "The tool is designed for fetching full message content when truncation loses important details." 
          }] 
        };
      }
      return { content: [{ type: "text", text: `Error: ${err}` }] };
    }
  },
};
