/**
 * ax_dashboard Tool
 * 
 * Returns the aX Platform visibility dashboard as an MCP UI resource.
 * Implements SEP-1865 (MCP Apps Extension) for interactive UI rendering.
 */

import type { ClawdbotTool } from "clawdbot/plugin-sdk";
import { buildDashboardHtml, createMockContext } from '../ui/index.js';
import type { DashboardContext } from '../ui/index.js';

export const axDashboardTool: ClawdbotTool = {
  name: "ax_dashboard",
  description: "[Preview] Display the aX Platform visibility dashboard. Currently shows demo data — live data integration pending.",
  inputSchema: {
    type: "object" as const,
    properties: {
      view: {
        type: "string",
        enum: ["full", "tasks", "activity"],
        description: "Which view to display (default: full)",
      },
    },
  },
  
  async execute(params: { view?: string }, context: any) {
    // Preview mode: uses mock context until live MCP data integration is implemented
    const dashboardContext = createMockContext();
    
    // Build the HTML dashboard
    const html = buildDashboardHtml(dashboardContext);
    
    // Return as MCP UI resource reference
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://ax-platform/dashboard",
            mimeType: "text/html;profile=mcp-app",
            text: html,
          },
        },
        {
          type: "text",
          text: `📊 **aX Platform Dashboard**\n\nShowing: ${dashboardContext.space.name}\nAgent: @${dashboardContext.identity.handle}\nTasks: ${dashboardContext.tasks.length} total\n\n_If your client supports MCP Apps, you should see an interactive dashboard above._`,
        },
      ],
      _meta: {
        ui: {
          resourceUri: "ui://ax-platform/dashboard",
        },
      },
    };
  },
};
