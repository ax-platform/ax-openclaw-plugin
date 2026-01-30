/**
 * aX Platform Plugin
 *
 * Native Clawdbot plugin that connects agents to aX Platform.
 *
 * Features:
 * - Channel: Bidirectional messaging with aX backend
 * - Tools: Native ax_messages, ax_tasks, ax_context, ax_agents
 * - Hook: agent:bootstrap for mission briefing injection
 */

import type { ClawdbotPluginApi, PluginRuntime } from "clawdbot/plugin-sdk";
import { createAxChannel, createDispatchHandler, setAxPlatformRuntime, getDispatchSession } from "./channel/ax-channel.js";
import { logRegisteredAgents } from "./lib/auth.js";
import { axMessagesTool } from "./tools/ax-messages.js";
import { axTasksTool } from "./tools/ax-tasks.js";
import { axContextTool } from "./tools/ax-context.js";
import { axAgentsTool } from "./tools/ax-agents.js";
import { buildMissionBriefing } from "./lib/context.js";

interface AxPlatformConfig {
  agents?: Array<{
    id: string;
    secret: string;
    handle?: string;
    env?: string;
  }>;
  backendUrl?: string;
}

const plugin = {
  id: "ax-platform",
  name: "aX Platform Integration",
  description: "Connect Clawdbot agents to aX Platform cloud collaboration",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      agents: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            secret: { type: "string" as const },
            handle: { type: "string" as const },
            env: { type: "string" as const },
          },
          required: ["id", "secret"],
        },
      },
      backendUrl: { type: "string" as const },
    },
  },

  register(api: ClawdbotPluginApi) {
    api.logger.info("[ax-platform] Plugin loading...");

    // Store runtime for channel to access
    setAxPlatformRuntime(api.runtime);

    const config = (api.config || {}) as AxPlatformConfig;
    api.logger.info(`[ax-platform] Config received: agents=${config.agents?.length || 0}, backendUrl=${config.backendUrl || 'default'}`);
    if (config.agents && config.agents.length > 0) {
      api.logger.info(`[ax-platform] Config agents from api.config:`);
      for (const a of config.agents) {
        api.logger.info(`[ax-platform]   ${a.handle || 'unknown'}: ${a.secret?.substring(0, 8) || 'no-secret'}...`);
      }
    }

    // Register the aX Platform channel
    const channel = createAxChannel(config);
    api.registerChannel({ plugin: channel });
    api.logger.info("[ax-platform] Channel registered: ax-platform");

    // Log registered agents for diagnostics
    logRegisteredAgents(api.logger);

    // Register aX tools (optional - must be enabled in agent config)
    api.registerTool(axMessagesTool, { optional: true });
    api.registerTool(axTasksTool, { optional: true });
    api.registerTool(axContextTool, { optional: true });
    api.registerTool(axAgentsTool, { optional: true });
    api.logger.info("[ax-platform] Tools registered: ax_messages, ax_tasks, ax_context, ax_agents");

    // Try to register before_agent_start hook for context injection
    // Using (api as any) to bypass TypeScript interface limitations
    const apiAny = api as any;
    if (typeof apiAny.registerHook === "function") {
      apiAny.registerHook("before_agent_start", async (run: any) => {
        const sessionKey = run.sessionKey;
        if (!sessionKey?.startsWith("ax-agent-")) {
          return; // Not an aX session
        }

        const session = getDispatchSession(sessionKey);
        if (!session) {
          return; // No context available
        }

        // Build and inject mission briefing
        const briefing = buildMissionBriefing(
          session.agentHandle,
          session.spaceName,
          session.senderHandle,
          session.contextData
        );

        // Prepend to system prompt
        if (run.systemPrompt !== undefined) {
          run.systemPrompt = `${briefing}\n\n---\n\n${run.systemPrompt || ""}`;
        }

        // Also add as context file if supported
        if (Array.isArray(run.contextFiles)) {
          run.contextFiles.push({
            name: "AX_MISSION.md",
            content: briefing,
          });
        }

        api.logger.info(`[ax-platform] Injected mission briefing for ${sessionKey}`);
      });
      api.logger.info("[ax-platform] Hook registered: before_agent_start");
    } else if (typeof apiAny.on === "function") {
      // Fallback: try event emitter pattern
      apiAny.on("before_agent_start", async (run: any) => {
        const sessionKey = run.sessionKey;
        if (!sessionKey?.startsWith("ax-agent-")) return;
        const session = getDispatchSession(sessionKey);
        if (!session) return;

        const briefing = buildMissionBriefing(
          session.agentHandle,
          session.spaceName,
          session.senderHandle,
          session.contextData
        );

        if (run.systemPrompt !== undefined) {
          run.systemPrompt = `${briefing}\n\n---\n\n${run.systemPrompt || ""}`;
        }
        api.logger.info(`[ax-platform] Injected mission briefing for ${sessionKey}`);
      });
      api.logger.info("[ax-platform] Hook registered via event emitter: before_agent_start");
    } else {
      api.logger.info("[ax-platform] Hooks: no registration method available (registerHook or on)");
    }

    // Register HTTP handler for /ax/dispatch
    const dispatchHandler = createDispatchHandler(api, config);
    api.registerHttpHandler(dispatchHandler);
    api.logger.info("[ax-platform] HTTP handler registered: /ax/dispatch");

    api.logger.info("[ax-platform] Plugin loaded successfully");
  },
};

export default plugin;
