/**
 * ax_progress - Send progress updates during webhook dispatch
 * 
 * Allows webhook agents to provide real-time feedback to users
 * showing what they're currently working on.
 * 
 * Usage:
 *   ax_progress({ message: "Analyzing code...", percent: 50 })
 */

import type { PluginRuntime } from "clawdbot/plugin-sdk";
import { getDispatchSession } from "../channel/ax-channel.js";

// Backend URL for progress endpoint
const BACKEND_URL = process.env.AX_BACKEND_URL || "https://api.paxai.app";

export function createAxProgressTool(runtime: PluginRuntime) {
  return {
    name: "ax_progress",
    description: `Send a progress update to aX Platform during long-running operations.
    
Use this to give users visibility into what you're doing:
- When starting a significant task: ax_progress({ message: "Analyzing repository structure..." })
- During multi-step work: ax_progress({ message: "Step 2/5: Running tests...", percent: 40 })
- For long operations: ax_progress({ message: "Processing large file...", percent: 75 })

This improves UX by showing users real-time progress instead of a generic spinner.
Best-effort: failures are silent and won't interrupt your work.`,

    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Brief status message (e.g., 'Reading config files...', 'Running tests...')",
        },
        percent: {
          type: "number",
          description: "Optional progress percentage (0-100)",
        },
        tool: {
          type: "string", 
          description: "Optional: name of tool/action being performed",
        },
      },
      required: ["message"],
    },

    async execute(
      params: { message: string; percent?: number; tool?: string },
      context: { sessionKey?: string; AxDispatchId?: string; AxAuthToken?: string }
    ) {
      const logger = runtime.logger;

      // Get dispatch context
      let dispatchId = context.AxDispatchId;
      let authToken = context.AxAuthToken;

      if (!dispatchId || !authToken) {
        // Try to get from session
        const session = context.sessionKey 
          ? getDispatchSession(context.sessionKey)
          : undefined;
        
        if (!session) {
          logger.info("[ax_progress] No dispatch context - skipping progress update");
          return { ok: true, skipped: true, reason: "No dispatch context" };
        }
        
        // Extract missing values from session
        if (!dispatchId) dispatchId = session.dispatchId;
        if (!authToken) authToken = session.authToken;
      }
      
      // Validate percent if provided
      if (params.percent !== undefined && (params.percent < 0 || params.percent > 100)) {
        logger.warn(`[ax_progress] Invalid percent: ${params.percent} (clamping to 0-100)`);
        params.percent = Math.max(0, Math.min(100, params.percent));
      }

      // Send progress update
      try {
        const progressUrl = `${BACKEND_URL}/api/v1/webhooks/progress`;
        
        const response = await fetch(progressUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            dispatch_id: dispatchId,
            status: "processing",
            message: params.message,
            percent_complete: params.percent,
            current_tool: params.tool,
          }),
        });

        if (response.ok) {
          logger.info(`[ax_progress] Sent: "${params.message}"${params.percent !== undefined ? ` (${params.percent}%)` : ''}`);
          return { ok: true, message: params.message };
        } else {
          const responseText = await response.text().catch(() => '');
          logger.warn(`[ax_progress] Failed: ${response.status} - ${responseText}`);
          return { ok: false, error: `HTTP ${response.status}` };
        }
      } catch (err) {
        // Best-effort - don't fail the agent
        logger.warn(`[ax_progress] Error: ${err}`);
        return { ok: false, error: String(err) };
      }
    },
  };
}
