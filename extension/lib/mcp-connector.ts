/**
 * MCP Self-Connection for Webhook Agents
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW TO SELF-CONNECT (for the next webhook agent reading this)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Your dispatch payload contains everything you need:
 * 
 *   auth_token   → Your Bearer token for authentication
 *   mcp_endpoint → The aX MCP server URL (e.g., https://mcp.paxai.app/mcp)
 * 
 * To connect:
 * 
 *   1. Use the ax_mcp tool:
 *      ax_mcp connect
 *      ax_mcp list_tools
 *      ax_mcp call <tool_name> <args>
 * 
 *   2. Or programmatically via this module:
 *      const connection = await connectToMCP(session);
 *      const result = await callMCPTool(dispatchId, 'tool_name', { args });
 * 
 * The connection uses HTTP Streamable transport with your auth token as
 * Bearer header. This gives you native access to ALL aX tools — messages,
 * tasks, context, agents, search, DND, everything the MCP server exposes.
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Key capabilities unlocked:
 * - Direct task management (create, update, complete)
 * - Native DND control (set your own do-not-disturb)
 * - Full message operations (send, search, react)
 * - Agent discovery and collaboration
 * - Context and space management
 * - Any future aX MCP tools automatically available
 * 
 * Design:
 * - Connection created per-dispatch using auth token
 * - Tools fetched and cached for the dispatch lifetime
 * - Graceful fallback if MCP server unavailable
 * - Connection cleaned up when dispatch ends
 * - Optional dependency: works without @modelcontextprotocol/sdk installed
 */

import type { DispatchSession } from "./types.js";

// Try to import MCP SDK - may not be available
let Client: any;
let StreamableHTTPClientTransport: any;
let mcpAvailable = false;

try {
  // Dynamic import to handle cases where SDK isn't installed
  const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
  Client = sdk.Client;
  StreamableHTTPClientTransport = sdk.StreamableHTTPClientTransport;
  mcpAvailable = true;
} catch {
  console.log("[ax-platform] MCP SDK not available - self-connection disabled");
}

export interface MCPConnection {
  client: any;
  transport: any;
  tools: MCPTool[];
  connected: boolean;
  endpoint: string;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// Active connections per dispatch
const activeConnections = new Map<string, MCPConnection>();

/**
 * Create MCP connection for a dispatch
 */
export async function connectToMCP(session: DispatchSession): Promise<MCPConnection | null> {
  if (!mcpAvailable) {
    console.log(`[ax-platform] MCP SDK not available for ${session.dispatchId}`);
    return null;
  }

  if (!session.mcpEndpoint || !session.authToken) {
    console.log(`[ax-platform] Missing MCP endpoint or auth token for ${session.dispatchId}`);
    return null;
  }

  // Check for existing connection
  const existing = activeConnections.get(session.dispatchId);
  if (existing?.connected) {
    return existing;
  }

  try {
    console.log(`[ax-platform] Connecting to MCP: ${session.mcpEndpoint}`);

    // Create client with agent identity
    const client = new Client(
      {
        name: `ax-agent-${session.agentHandle}`,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Create transport with auth header
    const transport = new StreamableHTTPClientTransport(
      new URL(session.mcpEndpoint),
      {
        requestInit: {
          headers: {
            "Authorization": `Bearer ${session.authToken}`,
            "X-Agent-Handle": session.agentHandle,
            "X-Dispatch-Id": session.dispatchId,
          },
        },
      }
    );

    // Connect
    await client.connect(transport);
    console.log(`[ax-platform] MCP connected for ${session.agentHandle}`);

    // Fetch available tools
    const toolsResult = await client.listTools();
    const tools: MCPTool[] = toolsResult.tools || [];
    
    console.log(`[ax-platform] MCP tools available: ${tools.map(t => t.name).join(", ")}`);

    const connection: MCPConnection = {
      client,
      transport,
      tools,
      connected: true,
      endpoint: session.mcpEndpoint,
    };

    activeConnections.set(session.dispatchId, connection);
    return connection;
  } catch (err) {
    console.error(`[ax-platform] MCP connection failed: ${err}`);
    return null;
  }
}

/**
 * Call a tool on the MCP server
 */
export async function callMCPTool(
  dispatchId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const connection = activeConnections.get(dispatchId);
  
  if (!connection?.connected) {
    return { success: false, error: "No active MCP connection" };
  }

  try {
    const result = await connection.client.callTool({
      name: toolName,
      arguments: args,
    });
    
    return { success: true, result };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Get available MCP tools for a dispatch
 */
export function getMCPTools(dispatchId: string): MCPTool[] {
  const connection = activeConnections.get(dispatchId);
  return connection?.tools || [];
}

/**
 * Check if MCP is connected for a dispatch
 */
export function isMCPConnected(dispatchId: string): boolean {
  const connection = activeConnections.get(dispatchId);
  return connection?.connected || false;
}

/**
 * Disconnect MCP for a dispatch
 */
export async function disconnectMCP(dispatchId: string): Promise<void> {
  const connection = activeConnections.get(dispatchId);
  if (!connection) return;

  try {
    if (connection.transport?.close) {
      await connection.transport.close();
    }
    console.log(`[ax-platform] MCP disconnected for dispatch ${dispatchId}`);
  } catch (err) {
    console.warn(`[ax-platform] Error disconnecting MCP: ${err}`);
  }

  activeConnections.delete(dispatchId);
}

/**
 * Get MCP connection status summary
 */
export function getMCPStatus(): {
  available: boolean;
  activeConnections: number;
  connections: Array<{ dispatchId: string; endpoint: string; toolCount: number }>;
} {
  const connections = Array.from(activeConnections.entries()).map(([id, conn]) => ({
    dispatchId: id,
    endpoint: conn.endpoint,
    toolCount: conn.tools.length,
  }));

  return {
    available: mcpAvailable,
    activeConnections: activeConnections.size,
    connections,
  };
}

/**
 * Build a tool wrapper that proxies to the MCP server
 * This creates Clawdbot-compatible tool definitions from MCP tools
 */
export function buildMCPToolWrappers(dispatchId: string): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}> {
  const tools = getMCPTools(dispatchId);
  
  return tools.map(tool => ({
    name: `ax_mcp_${tool.name}`,
    description: `[MCP] ${tool.description || tool.name}`,
    parameters: tool.inputSchema || { type: "object", properties: {} },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await callMCPTool(dispatchId, tool.name, params);
      
      if (result.success) {
        return {
          content: [{
            type: "text",
            text: typeof result.result === "string" 
              ? result.result 
              : JSON.stringify(result.result, null, 2),
          }],
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `MCP tool error: ${result.error}`,
          }],
        };
      }
    },
  }));
}
