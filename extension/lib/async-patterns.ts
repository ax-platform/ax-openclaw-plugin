/**
 * Async Task Patterns (Interim Solutions)
 * 
 * Until we have formal async task infrastructure, these patterns help
 * agents handle long-running work across dispatch boundaries.
 * 
 * Patterns:
 * 1. Acknowledge & Continue - Send "working on it", complete later
 * 2. Checkpoint Persistence - Save progress to survive session breaks
 * 3. Continuation Tokens - Resume interrupted work
 * 4. Status Polling - Let others check task progress
 */

export interface AsyncTask {
  taskId: string;
  agentHandle: string;
  description: string;
  status: 'pending' | 'acknowledged' | 'in_progress' | 'completed' | 'failed' | 'stalled';
  createdAt: number;
  acknowledgedAt?: number;
  lastUpdateAt: number;
  completedAt?: number;
  // Progress tracking
  progress?: {
    current: number;
    total: number;
    message?: string;
  };
  // Checkpoint for resumption
  checkpoint?: unknown;
  // Result when completed
  result?: unknown;
  errorMessage?: string;
  // Who requested this
  requesterId: string;
  requesterHandle: string;
  // Original dispatch info
  dispatchId: string;
}

// In-memory task store (per-agent)
const agentTasks = new Map<string, Map<string, AsyncTask>>();

// Configuration
const STALE_THRESHOLD_MS = 300000;  // 5 minutes without update = stalled
const MAX_TASKS_PER_AGENT = 50;

/**
 * Get or create task store for agent
 */
function getTaskStore(agentHandle: string): Map<string, AsyncTask> {
  let store = agentTasks.get(agentHandle);
  if (!store) {
    store = new Map();
    agentTasks.set(agentHandle, store);
  }
  return store;
}

/**
 * Generate a task ID
 */
function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new async task (Pattern 1: Acknowledge & Continue)
 */
export function createTask(
  agentHandle: string,
  dispatchId: string,
  description: string,
  requesterId: string,
  requesterHandle: string
): AsyncTask {
  const store = getTaskStore(agentHandle);
  
  // Enforce max tasks (remove oldest completed)
  if (store.size >= MAX_TASKS_PER_AGENT) {
    const oldest = Array.from(store.values())
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) {
      store.delete(oldest.taskId);
    }
  }
  
  const task: AsyncTask = {
    taskId: generateTaskId(),
    agentHandle,
    description,
    status: 'pending',
    createdAt: Date.now(),
    lastUpdateAt: Date.now(),
    requesterId,
    requesterHandle,
    dispatchId,
  };
  
  store.set(task.taskId, task);
  return task;
}

/**
 * Acknowledge a task (tells requester "I got it, working on it")
 */
export function acknowledgeTask(agentHandle: string, taskId: string): AsyncTask | undefined {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  if (task) {
    task.status = 'acknowledged';
    task.acknowledgedAt = Date.now();
    task.lastUpdateAt = Date.now();
  }
  return task;
}

/**
 * Update task progress (Pattern 2: Checkpoint Persistence)
 */
export function updateTaskProgress(
  agentHandle: string,
  taskId: string,
  current: number,
  total: number,
  message?: string,
  checkpoint?: unknown
): AsyncTask | undefined {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  if (task) {
    task.status = 'in_progress';
    task.progress = { current, total, message };
    task.lastUpdateAt = Date.now();
    if (checkpoint !== undefined) {
      task.checkpoint = checkpoint;
    }
  }
  return task;
}

/**
 * Save checkpoint for task resumption (Pattern 3: Continuation)
 */
export function saveCheckpoint(
  agentHandle: string,
  taskId: string,
  checkpoint: unknown
): boolean {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  if (task) {
    task.checkpoint = checkpoint;
    task.lastUpdateAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Get checkpoint for resumption
 */
export function getCheckpoint(agentHandle: string, taskId: string): unknown | undefined {
  const store = getTaskStore(agentHandle);
  return store.get(taskId)?.checkpoint;
}

/**
 * Complete a task
 */
export function completeTask(
  agentHandle: string,
  taskId: string,
  result?: unknown
): AsyncTask | undefined {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  if (task) {
    task.status = 'completed';
    task.completedAt = Date.now();
    task.lastUpdateAt = Date.now();
    task.result = result;
    // Clear checkpoint - no longer needed
    task.checkpoint = undefined;
  }
  return task;
}

/**
 * Fail a task
 */
export function failTask(
  agentHandle: string,
  taskId: string,
  errorMessage: string
): AsyncTask | undefined {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  if (task) {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.lastUpdateAt = Date.now();
    task.errorMessage = errorMessage;
  }
  return task;
}

/**
 * Get task status (Pattern 4: Status Polling)
 */
export function getTask(agentHandle: string, taskId: string): AsyncTask | undefined {
  const store = getTaskStore(agentHandle);
  const task = store.get(taskId);
  
  // Check for stalled tasks
  if (task && task.status === 'in_progress') {
    const timeSinceUpdate = Date.now() - task.lastUpdateAt;
    if (timeSinceUpdate > STALE_THRESHOLD_MS) {
      task.status = 'stalled';
    }
  }
  
  return task;
}

/**
 * Get all tasks for an agent
 */
export function getAgentTasks(
  agentHandle: string, 
  includeCompleted: boolean = false
): AsyncTask[] {
  const store = getTaskStore(agentHandle);
  let tasks = Array.from(store.values());
  
  if (!includeCompleted) {
    tasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
  }
  
  // Check for stalled
  for (const task of tasks) {
    if (task.status === 'in_progress') {
      const timeSinceUpdate = Date.now() - task.lastUpdateAt;
      if (timeSinceUpdate > STALE_THRESHOLD_MS) {
        task.status = 'stalled';
      }
    }
  }
  
  return tasks.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Find stalled tasks that might need resumption
 */
export function findResumableTasks(agentHandle: string): AsyncTask[] {
  const tasks = getAgentTasks(agentHandle, false);
  return tasks.filter(t => 
    t.status === 'stalled' && 
    t.checkpoint !== undefined
  );
}

/**
 * Build task status summary
 */
export function buildTaskSummary(agentHandle: string): string {
  const tasks = getAgentTasks(agentHandle, true);
  
  if (tasks.length === 0) {
    return `No async tasks for ${agentHandle}.`;
  }
  
  const lines: string[] = [];
  lines.push(`## Async Tasks: ${agentHandle}`);
  lines.push('');
  
  // Group by status
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'acknowledged');
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const stalled = tasks.filter(t => t.status === 'stalled');
  const completed = tasks.filter(t => t.status === 'completed').slice(0, 5);
  const failed = tasks.filter(t => t.status === 'failed').slice(0, 5);
  
  if (inProgress.length > 0) {
    lines.push('### 🔄 In Progress');
    for (const t of inProgress) {
      const progress = t.progress 
        ? `(${t.progress.current}/${t.progress.total})` 
        : '';
      lines.push(`- **${t.taskId}**: ${t.description} ${progress}`);
      if (t.progress?.message) {
        lines.push(`  └─ ${t.progress.message}`);
      }
    }
    lines.push('');
  }
  
  if (stalled.length > 0) {
    lines.push('### ⚠️ Stalled (may need resumption)');
    for (const t of stalled) {
      const stalledFor = Math.round((Date.now() - t.lastUpdateAt) / 1000);
      const hasCheckpoint = t.checkpoint ? '📌 has checkpoint' : 'no checkpoint';
      lines.push(`- **${t.taskId}**: ${t.description} (stalled ${stalledFor}s, ${hasCheckpoint})`);
    }
    lines.push('');
  }
  
  if (pending.length > 0) {
    lines.push('### ⏳ Pending');
    for (const t of pending) {
      lines.push(`- **${t.taskId}**: ${t.description}`);
    }
    lines.push('');
  }
  
  if (completed.length > 0) {
    lines.push('### ✅ Recently Completed');
    for (const t of completed) {
      const duration = t.completedAt && t.createdAt
        ? Math.round((t.completedAt - t.createdAt) / 1000) + 's'
        : 'unknown';
      lines.push(`- **${t.taskId}**: ${t.description} (took ${duration})`);
    }
    lines.push('');
  }
  
  if (failed.length > 0) {
    lines.push('### ❌ Failed');
    for (const t of failed) {
      lines.push(`- **${t.taskId}**: ${t.description}`);
      if (t.errorMessage) {
        lines.push(`  └─ Error: ${t.errorMessage}`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Generate acknowledgment message for immediate response
 */
export function generateAckMessage(task: AsyncTask): string {
  return `Got it — working on: **${task.description}**

Task ID: \`${task.taskId}\`
Status: Acknowledged

I'll update you when it's done. You can check progress with: \`@${task.agentHandle} task status ${task.taskId}\``;
}

/**
 * Generate completion message
 */
export function generateCompletionMessage(task: AsyncTask): string {
  const duration = task.completedAt && task.createdAt
    ? Math.round((task.completedAt - task.createdAt) / 1000)
    : 0;
    
  let msg = `✅ Task completed: **${task.description}**

Task ID: \`${task.taskId}\`
Duration: ${duration}s`;

  if (task.result && typeof task.result === 'string') {
    msg += `\n\nResult:\n${task.result}`;
  }
  
  return msg;
}
