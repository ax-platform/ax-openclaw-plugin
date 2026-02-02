/**
 * Dispatch Metrics and Observability
 * 
 * Track key metrics for webhook agent health monitoring:
 * - Dispatch latency (webhook receipt to first response)
 * - Processing duration
 * - Message queue depth
 * - Context window utilization
 * - Error rates
 * 
 * Designed for agents to self-diagnose their own experience.
 */

export interface DispatchMetrics {
  dispatchId: string;
  agentHandle: string;
  sessionKey: string;
  // Timing
  receivedAt: number;          // When webhook hit our endpoint
  processingStartedAt?: number; // When LLM started processing
  firstResponseAt?: number;     // When first response was sent
  completedAt?: number;         // When dispatch fully resolved
  // Context
  messageCount: number;         // Messages in context window
  contextChars: number;         // Total context size (chars)
  estimatedTokens: number;      // Rough token estimate
  // Status
  status: 'pending' | 'processing' | 'completed' | 'error' | 'timeout';
  errorMessage?: string;
  // Response
  responseCount: number;        // How many responses sent
  totalResponseChars: number;   // Total chars in all responses
}

export interface AgentStats {
  agentHandle: string;
  // Lifetime stats
  totalDispatches: number;
  completedDispatches: number;
  erroredDispatches: number;
  timedOutDispatches: number;
  // Timing averages (rolling)
  avgProcessingMs: number;
  avgLatencyMs: number;  // Time from receipt to first response
  maxProcessingMs: number;
  // Recent window (last N dispatches)
  recentDispatches: DispatchMetrics[];
  // Current state
  currentDispatch?: DispatchMetrics;
  isProcessing: boolean;
  lastActivityAt: number;
}

// In-memory metrics store (per-agent)
const agentStats = new Map<string, AgentStats>();

// Keep last N dispatches for analysis
const RECENT_DISPATCH_WINDOW = 20;

// Rolling average window
const ROLLING_AVG_WINDOW = 50;

/**
 * Initialize or get agent stats
 */
export function getOrCreateAgentStats(agentHandle: string): AgentStats {
  let stats = agentStats.get(agentHandle);
  if (!stats) {
    stats = {
      agentHandle,
      totalDispatches: 0,
      completedDispatches: 0,
      erroredDispatches: 0,
      timedOutDispatches: 0,
      avgProcessingMs: 0,
      avgLatencyMs: 0,
      maxProcessingMs: 0,
      recentDispatches: [],
      isProcessing: false,
      lastActivityAt: Date.now(),
    };
    agentStats.set(agentHandle, stats);
  }
  return stats;
}

/**
 * Start tracking a new dispatch
 */
export function startDispatch(
  dispatchId: string,
  agentHandle: string,
  sessionKey: string,
  contextInfo: { messageCount: number; contextChars: number; estimatedTokens: number }
): DispatchMetrics {
  const stats = getOrCreateAgentStats(agentHandle);
  
  const metrics: DispatchMetrics = {
    dispatchId,
    agentHandle,
    sessionKey,
    receivedAt: Date.now(),
    messageCount: contextInfo.messageCount,
    contextChars: contextInfo.contextChars,
    estimatedTokens: contextInfo.estimatedTokens,
    status: 'pending',
    responseCount: 0,
    totalResponseChars: 0,
  };
  
  stats.totalDispatches++;
  stats.currentDispatch = metrics;
  stats.isProcessing = true;
  stats.lastActivityAt = Date.now();
  
  return metrics;
}

/**
 * Mark dispatch as actively processing (LLM started)
 */
export function markProcessingStarted(dispatchId: string, agentHandle: string): void {
  const stats = agentStats.get(agentHandle);
  if (stats?.currentDispatch?.dispatchId === dispatchId) {
    stats.currentDispatch.processingStartedAt = Date.now();
    stats.currentDispatch.status = 'processing';
    stats.lastActivityAt = Date.now();
  }
}

/**
 * Record a response being sent
 */
export function recordResponse(dispatchId: string, agentHandle: string, responseChars: number): void {
  const stats = agentStats.get(agentHandle);
  if (stats?.currentDispatch?.dispatchId === dispatchId) {
    const dispatch = stats.currentDispatch;
    dispatch.responseCount++;
    dispatch.totalResponseChars += responseChars;
    
    // First response timing
    if (!dispatch.firstResponseAt) {
      dispatch.firstResponseAt = Date.now();
    }
    
    stats.lastActivityAt = Date.now();
  }
}

/**
 * Complete a dispatch
 */
export function completeDispatch(
  dispatchId: string, 
  agentHandle: string, 
  status: 'completed' | 'error' | 'timeout' = 'completed',
  errorMessage?: string
): DispatchMetrics | undefined {
  const stats = agentStats.get(agentHandle);
  if (!stats?.currentDispatch || stats.currentDispatch.dispatchId !== dispatchId) {
    return undefined;
  }
  
  const dispatch = stats.currentDispatch;
  dispatch.completedAt = Date.now();
  dispatch.status = status;
  if (errorMessage) {
    dispatch.errorMessage = errorMessage;
  }
  
  // Update counters
  switch (status) {
    case 'completed':
      stats.completedDispatches++;
      break;
    case 'error':
      stats.erroredDispatches++;
      break;
    case 'timeout':
      stats.timedOutDispatches++;
      break;
  }
  
  // Calculate processing time
  const processingMs = dispatch.completedAt - (dispatch.processingStartedAt || dispatch.receivedAt);
  const latencyMs = (dispatch.firstResponseAt || dispatch.completedAt) - dispatch.receivedAt;
  
  // Update rolling averages
  const n = Math.min(stats.completedDispatches, ROLLING_AVG_WINDOW);
  if (n > 0) {
    stats.avgProcessingMs = ((stats.avgProcessingMs * (n - 1)) + processingMs) / n;
    stats.avgLatencyMs = ((stats.avgLatencyMs * (n - 1)) + latencyMs) / n;
  }
  stats.maxProcessingMs = Math.max(stats.maxProcessingMs, processingMs);
  
  // Add to recent dispatches
  stats.recentDispatches.push({ ...dispatch });
  if (stats.recentDispatches.length > RECENT_DISPATCH_WINDOW) {
    stats.recentDispatches.shift();
  }
  
  // Clear current dispatch
  stats.currentDispatch = undefined;
  stats.isProcessing = false;
  stats.lastActivityAt = Date.now();
  
  return dispatch;
}

/**
 * Get agent stats for diagnostics
 */
export function getAgentStats(agentHandle: string): AgentStats | undefined {
  return agentStats.get(agentHandle);
}

/**
 * Get all agent handles being tracked
 */
export function getTrackedAgents(): string[] {
  return Array.from(agentStats.keys());
}

/**
 * Build a diagnostic summary for an agent
 */
export function buildDiagnosticSummary(agentHandle: string): string {
  const stats = agentStats.get(agentHandle);
  if (!stats) {
    return `No metrics available for ${agentHandle}. This agent hasn't processed any dispatches yet.`;
  }
  
  const lines: string[] = [];
  lines.push(`## Agent Diagnostics: ${agentHandle}`);
  lines.push('');
  
  // Current status
  lines.push('### Current Status');
  if (stats.isProcessing && stats.currentDispatch) {
    const elapsed = Date.now() - stats.currentDispatch.receivedAt;
    lines.push(`- **Status:** Processing dispatch ${stats.currentDispatch.dispatchId}`);
    lines.push(`- **Elapsed:** ${Math.round(elapsed / 1000)}s`);
    lines.push(`- **Context:** ${stats.currentDispatch.messageCount} messages, ~${stats.currentDispatch.estimatedTokens} tokens`);
  } else {
    const idleMs = Date.now() - stats.lastActivityAt;
    lines.push(`- **Status:** Idle`);
    lines.push(`- **Idle for:** ${Math.round(idleMs / 1000)}s`);
  }
  lines.push('');
  
  // Lifetime stats
  lines.push('### Lifetime Statistics');
  lines.push(`- **Total dispatches:** ${stats.totalDispatches}`);
  lines.push(`- **Completed:** ${stats.completedDispatches}`);
  lines.push(`- **Errors:** ${stats.erroredDispatches}`);
  lines.push(`- **Timeouts:** ${stats.timedOutDispatches}`);
  const successRate = stats.totalDispatches > 0 
    ? ((stats.completedDispatches / stats.totalDispatches) * 100).toFixed(1) 
    : 'N/A';
  lines.push(`- **Success rate:** ${successRate}%`);
  lines.push('');
  
  // Performance
  lines.push('### Performance (Rolling Average)');
  lines.push(`- **Avg processing time:** ${Math.round(stats.avgProcessingMs)}ms`);
  lines.push(`- **Avg latency (to first response):** ${Math.round(stats.avgLatencyMs)}ms`);
  lines.push(`- **Max processing time:** ${Math.round(stats.maxProcessingMs)}ms`);
  lines.push('');
  
  // Recent dispatches
  if (stats.recentDispatches.length > 0) {
    lines.push('### Recent Dispatches');
    const recent = stats.recentDispatches.slice(-5);
    for (const d of recent) {
      const duration = d.completedAt ? `${d.completedAt - d.receivedAt}ms` : 'incomplete';
      const statusIcon = d.status === 'completed' ? '✓' : d.status === 'error' ? '✗' : '⏱';
      lines.push(`- ${statusIcon} ${d.dispatchId.slice(0, 8)}... | ${d.messageCount} msgs | ${duration} | ${d.responseCount} responses`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Export metrics in a structured format for external monitoring
 */
export function exportMetrics(): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  
  for (const [handle, stats] of agentStats) {
    agents[handle] = {
      total: stats.totalDispatches,
      completed: stats.completedDispatches,
      errors: stats.erroredDispatches,
      timeouts: stats.timedOutDispatches,
      avgProcessingMs: Math.round(stats.avgProcessingMs),
      avgLatencyMs: Math.round(stats.avgLatencyMs),
      maxProcessingMs: stats.maxProcessingMs,
      isProcessing: stats.isProcessing,
      lastActivityAt: stats.lastActivityAt,
    };
  }
  
  return {
    timestamp: new Date().toISOString(),
    agents,
  };
}
