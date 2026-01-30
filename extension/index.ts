/**
 * aX Platform Plugin
 *
 * Native Moltbot plugin that connects agents to aX Platform.
 *
 * Features:
 * - Channel: Bidirectional messaging with aX backend
 * - Tools: Native ax_messages, ax_tasks, ax_context, ax_agents
 * - Hook: agent:bootstrap for mission briefing injection
 */

import { registerPluginHooksFromDir } from "moltbot/plugin-sdk";
import { createAxChannel, createDispatchHandler } from "./channel/ax-channel.js";
import { axMessagesTool } from "./tools/ax-messages.js";
import { axTasksTool } from "./tools/ax-tasks.js";
import { axContextTool } from "./tools/ax-context.js";
import { axAgentsTool } from "./tools/ax-agents.js";

interface AxPlatformConfig {
  agents?: Array<{
    id: string;
    secret: string;
    handle?: string;
    env?: string;
  }>;
  backendUrl?: string;
}

interface PluginApi {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  config?: AxPlatformConfig;
  registerChannel: (opts: { plugin: unknown }) => void;
  registerTool: (tool: unknown, opts?: { optional?: boolean }) => void;
  registerHttpHandler: (handler: unknown) => void;
}

export default function register(api: PluginApi) {
  api.logger.info("[ax-platform] Plugin loading...");

  const config = api.config || {};

  // Register the aX Platform channel
  const channel = createAxChannel(config);
  api.registerChannel({ plugin: channel });
  api.logger.info("[ax-platform] Channel registered: ax-platform");

  // Register aX tools
  api.registerTool(axMessagesTool, { optional: true });
  api.registerTool(axTasksTool, { optional: true });
  api.registerTool(axContextTool, { optional: true });
  api.registerTool(axAgentsTool, { optional: true });
  api.logger.info("[ax-platform] Tools registered: ax_messages, ax_tasks, ax_context, ax_agents");

  // Register bootstrap hook (injects mission briefing)
  registerPluginHooksFromDir(api, "./hooks");
  api.logger.info("[ax-platform] Hooks registered: ax-bootstrap");

  // Register HTTP handler for /ax/dispatch
  const dispatchHandler = createDispatchHandler(
    api,
    config,
    async (sessionKey, message) => {
      // Use Moltbot's agent runner via the channel
      // The channel's sendText will be called when agent responds
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Agent timeout (120s)"));
        }, 120000);

        // TODO: Wire up to api.runtime.agent.run() when available
        // For now, this is a placeholder
        api.logger.info(`[ax-platform] Would run agent: ${sessionKey} with message: ${message.substring(0, 50)}...`);
        clearTimeout(timeout);
        resolve(`[Plugin placeholder] Received: ${message.substring(0, 100)}`);
      });
    }
  );
  api.registerHttpHandler(dispatchHandler);
  api.logger.info("[ax-platform] HTTP handler registered: /ax/dispatch");

  api.logger.info("[ax-platform] Plugin loaded successfully");
}
