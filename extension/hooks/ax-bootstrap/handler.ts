/**
 * aX Bootstrap Hook — DISABLED
 *
 * Previously injected mission briefing as a bootstrap file (AX_MISSION.md).
 * This caused double context injection because the same briefing was also
 * injected via the before_agent_start hook in index.ts (prependContext).
 *
 * The before_agent_start hook is now the single injection point.
 * This handler is kept as a no-op to avoid plugin load errors.
 */

import type { HookHandler } from "clawdbot/hooks";

const handler: HookHandler = async (_event) => {
  // No-op: context injection is handled by before_agent_start in index.ts
};

export default handler;
