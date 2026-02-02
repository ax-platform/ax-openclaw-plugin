/**
 * ax_diagnostics tool - Self-health monitoring for webhook agents
 * 
 * Allows agents to introspect their own operational state:
 * - Dispatch metrics (latency, processing time, error rates)
 * - DND status and queue depth
 * - Async task status
 * - Context window utilization
 * 
 * This is the agent's self-awareness tool.
 */

import { Type } from "@sinclair/typebox";
import { getDispatchSession } from "../channel/ax-channel.js";
import { buildDiagnosticSummary, getAgentStats, exportMetrics } from "../lib/metrics.js";
import { buildDNDStatus, getDNDState, enableDND, disableDND, peekQueue } from "../lib/dnd.js";
import { buildTaskSummary, getAgentTasks, findResumableTasks } from "../lib/async-patterns.js";

export const axDiagnosticsTool = {
  name: "ax_diagnostics",
  description: `Self-health monitoring and control. Actions:
- status: Full diagnostic summary (metrics, DND, tasks)
- metrics: Dispatch performance metrics only
- dnd_status: DND mode status and queue
- dnd_enable: Enable Do Not Disturb (queue incoming dispatches)
- dnd_disable: Disable DND and process queue
- tasks: Async task status
- resumable: Find stalled tasks with checkpoints`,
  
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("metrics"),
      Type.Literal("dnd_status"),
      Type.Literal("dnd_enable"),
      Type.Literal("dnd_disable"),
      Type.Literal("tasks"),
      Type.Literal("resumable"),
    ], {
      description: "Diagnostic action to perform",
    }),
    dnd_reason: Type.Optional(Type.String({ 
      description: "Reason for enabling DND (for dnd_enable)" 
    })),
    dnd_duration_minutes: Type.Optional(Type.Number({ 
      description: "DND duration in minutes (auto-expires). Default: no expiry." 
    })),
  }),

  async execute(_toolCallId: string, params: Record<string, unknown>, context: { sessionKey?: string }) {
    const sessionKey = context.sessionKey;
    const session = sessionKey ? getDispatchSession(sessionKey) : undefined;

    if (!session?.agentHandle) {
      return { 
        content: [{ 
          type: "text", 
          text: "Error: No aX session context. Diagnostics only available during active dispatches." 
        }] 
      };
    }

    const agentHandle = session.agentHandle;
    const action = params.action as string;

    try {
      switch (action) {
        case "status": {
          // Full diagnostic summary
          const sections: string[] = [];
          
          sections.push("# Self-Diagnostic Report");
          sections.push(`Agent: ${agentHandle}`);
          sections.push(`Timestamp: ${new Date().toISOString()}`);
          sections.push("");
          
          // Metrics
          sections.push(buildDiagnosticSummary(agentHandle));
          sections.push("");
          
          // DND
          sections.push(buildDNDStatus(agentHandle));
          sections.push("");
          
          // Tasks
          sections.push(buildTaskSummary(agentHandle));
          
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }
        
        case "metrics": {
          const summary = buildDiagnosticSummary(agentHandle);
          return { content: [{ type: "text", text: summary }] };
        }
        
        case "dnd_status": {
          const status = buildDNDStatus(agentHandle);
          return { content: [{ type: "text", text: status }] };
        }
        
        case "dnd_enable": {
          const reason = params.dnd_reason as string | undefined;
          const durationMin = params.dnd_duration_minutes as number | undefined;
          const durationMs = durationMin ? durationMin * 60 * 1000 : undefined;
          
          enableDND(agentHandle, reason || "Manually enabled via diagnostics", durationMs);
          
          const state = getDNDState(agentHandle);
          let response = `🔕 DND enabled for ${agentHandle}`;
          if (reason) response += `\nReason: ${reason}`;
          if (durationMs) response += `\nAuto-expires in: ${durationMin} minutes`;
          response += `\n\nIncoming dispatches will be queued (max ${state.maxQueueSize}).`;
          
          return { content: [{ type: "text", text: response }] };
        }
        
        case "dnd_disable": {
          const queued = disableDND(agentHandle);
          
          let response = `🔔 DND disabled for ${agentHandle}`;
          if (queued.length > 0) {
            response += `\n\n**${queued.length} queued dispatch(es) ready for processing:**`;
            for (const q of queued) {
              response += `\n- @${q.senderHandle}: "${q.messagePreview}"`;
            }
            response += `\n\nNote: These dispatches need to be reprocessed through the normal flow.`;
          } else {
            response += `\n\nNo dispatches were queued.`;
          }
          
          return { content: [{ type: "text", text: response }] };
        }
        
        case "tasks": {
          const summary = buildTaskSummary(agentHandle);
          return { content: [{ type: "text", text: summary }] };
        }
        
        case "resumable": {
          const resumable = findResumableTasks(agentHandle);
          
          if (resumable.length === 0) {
            return { 
              content: [{ 
                type: "text", 
                text: "No resumable tasks found. All tasks are either in progress, completed, or have no checkpoint." 
              }] 
            };
          }
          
          const lines: string[] = [];
          lines.push("## Resumable Tasks");
          lines.push("");
          lines.push("These tasks have stalled but have saved checkpoints for resumption:");
          lines.push("");
          
          for (const task of resumable) {
            const stalledFor = Math.round((Date.now() - task.lastUpdateAt) / 1000);
            lines.push(`### ${task.taskId}`);
            lines.push(`- **Description:** ${task.description}`);
            lines.push(`- **Stalled for:** ${stalledFor}s`);
            lines.push(`- **Requested by:** @${task.requesterHandle}`);
            if (task.progress) {
              lines.push(`- **Last progress:** ${task.progress.current}/${task.progress.total} - ${task.progress.message || 'no message'}`);
            }
            lines.push(`- **Checkpoint type:** ${typeof task.checkpoint}`);
            lines.push("");
          }
          
          lines.push("To resume a task, retrieve its checkpoint and continue from that state.");
          
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        
        default:
          return { 
            content: [{ 
              type: "text", 
              text: `Unknown action: ${action}. Valid actions: status, metrics, dnd_status, dnd_enable, dnd_disable, tasks, resumable` 
            }] 
          };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Diagnostic error: ${err}` }] };
    }
  },
};

/**
 * Export metrics for external monitoring (e.g., HTTP endpoint)
 */
export function getMetricsExport(): Record<string, unknown> {
  return exportMetrics();
}
