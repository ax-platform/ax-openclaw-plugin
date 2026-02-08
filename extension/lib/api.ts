/**
 * aX Backend API calls
 */

/**
 * Send progress update to backend (fire-and-forget)
 */
export async function sendProgressUpdate(
  backendUrl: string,
  authToken: string,
  dispatchId: string,
  status: "processing" | "completed" | "error",
  tool?: string,
  message?: string
): Promise<void> {
  const progressUrl = `${backendUrl}/api/v1/webhooks/progress`;

  try {
    await fetch(progressUrl, {
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
  } catch {
    // Fire-and-forget - don't fail dispatch if progress fails
  }
}

/**
 * Call aX MCP tool via JSON-RPC (MCP protocol)
 *
 * The MCP server speaks JSON-RPC at {mcpEndpoint}/mcp.
 * We send a `tools/call` request with the tool name and arguments.
 *
 * Previous implementation used REST: `${mcpEndpoint}/tools/${toolName}`
 * which doesn't exist on the MCP server. Fixed to use proper MCP JSON-RPC.
 */
export async function callAxTool(
  mcpEndpoint: string,
  authToken: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (!mcpEndpoint) throw new Error("callAxTool: mcpEndpoint is required");
  if (!authToken) throw new Error("callAxTool: authToken is required");
  if (!toolName) throw new Error("callAxTool: toolName is required");

  // Ensure endpoint ends with /mcp (the JSON-RPC endpoint)
  const rpcUrl = mcpEndpoint.endsWith("/mcp")
    ? mcpEndpoint
    : `${mcpEndpoint.replace(/\/+$/, "")}/mcp`;

  const body = {
    jsonrpc: "2.0",
    id: `ax-plugin-${Date.now()}`,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: params,
    },
  };

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`aX tool ${toolName} failed: ${response.status} ${errText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Handle SSE (streaming) responses — collect until we get a JSON-RPC result
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    // Parse SSE events — find the last `data:` line with a JSON-RPC result
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("data:")) {
        try {
          const eventData = JSON.parse(line.slice(5).trim());
          if (eventData.result) {
            return extractToolResult(eventData.result);
          }
          if (eventData.error) {
            throw new Error(`MCP error: ${eventData.error.message || JSON.stringify(eventData.error)}`);
          }
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.startsWith("MCP error:")) throw parseErr;
          // Not valid JSON — log for debugging and skip
          if (process.env.DEBUG || process.env.LOG_LEVEL === "debug") {
            console.debug(`[ax-platform] SSE parse skip: ${line.substring(0, 100)}`);
          }
        }
      }
    }
    throw new Error(`aX tool ${toolName}: no result in SSE stream`);
  }

  // Handle plain JSON-RPC response
  const rpcResult = await response.json();
  if (rpcResult.error) {
    throw new Error(`MCP error: ${rpcResult.error.message || JSON.stringify(rpcResult.error)}`);
  }
  return extractToolResult(rpcResult.result);
}

/**
 * Extract the text content from an MCP tools/call result.
 *
 * MCP returns results in the format:
 *   { content: [{ type: "text", text: "..." }, ...] }
 *
 * This function:
 * 1. Extracts all text content parts from the content array
 * 2. Joins them with newlines
 * 3. Attempts to parse as JSON (for structured results like message lists)
 * 4. Falls back to raw text string if not valid JSON
 * 5. Returns the original result if no content array is present
 */
function extractToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const textParts = (r.content as Array<{ type?: string; text?: string }>)
      .filter(c => c.type === "text" && c.text)
      .map(c => c.text!);
    const joined = textParts.join("\n");
    try {
      return JSON.parse(joined);
    } catch {
      return joined || result;
    }
  }
  return result;
}
