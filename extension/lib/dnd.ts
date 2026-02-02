/**
 * Do Not Disturb Mode
 * 
 * When an agent is deep in work, incoming dispatches should queue up
 * instead of interrupting with new sessions. This prevents:
 * - Context thrashing during complex tasks
 * - Lost work when interrupted mid-thought
 * - Cognitive overload from concurrent dispatches
 * 
 * Design:
 * - DND can be triggered manually or automatically (based on processing time)
 * - Queued messages are delivered when DND ends
 * - Auto-DND kicks in when processing exceeds a threshold
 * - Messages can be peeked without breaking DND
 */

export interface QueuedDispatch {
  dispatchId: string;
  payload: unknown;  // Original webhook payload
  queuedAt: number;
  senderHandle: string;
  messagePreview: string;  // First ~100 chars for peeking
}

export interface DNDState {
  enabled: boolean;
  reason?: string;           // Why DND is on
  enabledAt?: number;
  autoEnabled: boolean;      // Was this auto-triggered?
  expiresAt?: number;        // Optional auto-expire
  queuedDispatches: QueuedDispatch[];
  maxQueueSize: number;      // Prevent unbounded growth
}

// DND state per agent
const agentDND = new Map<string, DNDState>();

// Configuration
const DEFAULT_CONFIG = {
  maxQueueSize: 20,                // Max dispatches to queue
  autoEnableAfterMs: 30000,        // Auto-DND if processing > 30s
  autoDNDDurationMs: 300000,       // Auto-DND lasts 5 min max
  messagePreviewLength: 100,
};

/**
 * Get or initialize DND state for an agent
 */
export function getDNDState(agentHandle: string): DNDState {
  let state = agentDND.get(agentHandle);
  if (!state) {
    state = {
      enabled: false,
      autoEnabled: false,
      queuedDispatches: [],
      maxQueueSize: DEFAULT_CONFIG.maxQueueSize,
    };
    agentDND.set(agentHandle, state);
  }
  return state;
}

/**
 * Enable DND mode
 */
export function enableDND(
  agentHandle: string, 
  reason?: string, 
  durationMs?: number,
  auto: boolean = false
): void {
  const state = getDNDState(agentHandle);
  state.enabled = true;
  state.reason = reason || (auto ? 'Auto-enabled during long task' : 'Manually enabled');
  state.enabledAt = Date.now();
  state.autoEnabled = auto;
  
  if (durationMs) {
    state.expiresAt = Date.now() + durationMs;
  } else {
    state.expiresAt = undefined;
  }
}

/**
 * Disable DND mode (also returns any queued dispatches)
 */
export function disableDND(agentHandle: string): QueuedDispatch[] {
  const state = getDNDState(agentHandle);
  const queued = [...state.queuedDispatches];
  
  state.enabled = false;
  state.reason = undefined;
  state.enabledAt = undefined;
  state.autoEnabled = false;
  state.expiresAt = undefined;
  state.queuedDispatches = [];
  
  return queued;
}

/**
 * Check if DND is active (accounts for expiration)
 */
export function isDNDActive(agentHandle: string): boolean {
  const state = agentDND.get(agentHandle);
  if (!state?.enabled) return false;
  
  // Check expiration
  if (state.expiresAt && Date.now() > state.expiresAt) {
    // Auto-disable expired DND
    disableDND(agentHandle);
    return false;
  }
  
  return true;
}

/**
 * Queue a dispatch during DND
 * Returns true if queued, false if queue is full
 */
export function queueDispatch(
  agentHandle: string,
  dispatchId: string,
  payload: unknown,
  senderHandle: string,
  messageContent: string
): { queued: boolean; position: number; queueFull: boolean } {
  const state = getDNDState(agentHandle);
  
  // Check queue capacity
  if (state.queuedDispatches.length >= state.maxQueueSize) {
    return { queued: false, position: -1, queueFull: true };
  }
  
  // Create preview
  const preview = messageContent.length > DEFAULT_CONFIG.messagePreviewLength
    ? messageContent.substring(0, DEFAULT_CONFIG.messagePreviewLength) + '...'
    : messageContent;
  
  state.queuedDispatches.push({
    dispatchId,
    payload,
    queuedAt: Date.now(),
    senderHandle,
    messagePreview: preview,
  });
  
  return { 
    queued: true, 
    position: state.queuedDispatches.length,
    queueFull: state.queuedDispatches.length >= state.maxQueueSize,
  };
}

/**
 * Peek at queued dispatches without consuming
 */
export function peekQueue(agentHandle: string): QueuedDispatch[] {
  const state = agentDND.get(agentHandle);
  return state?.queuedDispatches || [];
}

/**
 * Get queue depth
 */
export function getQueueDepth(agentHandle: string): number {
  const state = agentDND.get(agentHandle);
  return state?.queuedDispatches.length || 0;
}

/**
 * Auto-DND trigger (call this when processing starts or continues)
 * Returns true if auto-DND was enabled
 */
export function checkAutoEnable(
  agentHandle: string, 
  processingStartedAt: number
): boolean {
  const state = getDNDState(agentHandle);
  
  // Already in DND
  if (state.enabled) return false;
  
  // Check if processing has exceeded threshold
  const elapsed = Date.now() - processingStartedAt;
  if (elapsed >= DEFAULT_CONFIG.autoEnableAfterMs) {
    enableDND(
      agentHandle,
      `Auto-enabled: processing task for ${Math.round(elapsed / 1000)}s`,
      DEFAULT_CONFIG.autoDNDDurationMs,
      true
    );
    return true;
  }
  
  return false;
}

/**
 * Build DND status summary
 */
export function buildDNDStatus(agentHandle: string): string {
  const state = agentDND.get(agentHandle);
  
  if (!state || !state.enabled) {
    return `DND is **off** for ${agentHandle}. Dispatches processed immediately.`;
  }
  
  const lines: string[] = [];
  lines.push(`## DND Status: ${agentHandle}`);
  lines.push('');
  lines.push(`**Status:** 🔕 Do Not Disturb`);
  lines.push(`**Reason:** ${state.reason}`);
  
  if (state.enabledAt) {
    const elapsed = Math.round((Date.now() - state.enabledAt) / 1000);
    lines.push(`**Active for:** ${elapsed}s`);
  }
  
  if (state.expiresAt) {
    const remaining = Math.round((state.expiresAt - Date.now()) / 1000);
    lines.push(`**Auto-expires in:** ${remaining}s`);
  }
  
  lines.push('');
  lines.push(`### Queued Dispatches: ${state.queuedDispatches.length}/${state.maxQueueSize}`);
  
  if (state.queuedDispatches.length > 0) {
    for (const q of state.queuedDispatches) {
      const waitTime = Math.round((Date.now() - q.queuedAt) / 1000);
      lines.push(`- @${q.senderHandle} (${waitTime}s ago): "${q.messagePreview}"`);
    }
  } else {
    lines.push('*Queue is empty*');
  }
  
  return lines.join('\n');
}

/**
 * Handle incoming dispatch - either process or queue
 * Returns: { shouldProcess: boolean, queueInfo?: { position, queueDepth } }
 */
export function handleIncomingDispatch(
  agentHandle: string,
  dispatchId: string,
  payload: unknown,
  senderHandle: string,
  messageContent: string
): { 
  shouldProcess: boolean; 
  queuedPosition?: number; 
  queueDepth?: number;
  queueFull?: boolean;
} {
  // Check if DND is active
  if (!isDNDActive(agentHandle)) {
    return { shouldProcess: true };
  }
  
  // Queue the dispatch
  const result = queueDispatch(agentHandle, dispatchId, payload, senderHandle, messageContent);
  
  return {
    shouldProcess: false,
    queuedPosition: result.position,
    queueDepth: getDNDState(agentHandle).queuedDispatches.length,
    queueFull: result.queueFull,
  };
}

/**
 * Process queued dispatches (returns dispatches in order)
 * Call this when DND ends or when ready to process queue
 */
export function drainQueue(agentHandle: string): QueuedDispatch[] {
  const state = agentDND.get(agentHandle);
  if (!state) return [];
  
  const queued = [...state.queuedDispatches];
  state.queuedDispatches = [];
  
  return queued;
}
