/**
 * MCP UI Dashboard Builder
 * 
 * Generates the HTML for the aX Platform visibility dashboard.
 * Built on SEP-1865 (MCP Apps Extension) using Flowbite/Tailwind components.
 */

import type { DashboardContext, Task, ActivityBreadcrumb } from './types.js';

/**
 * Build the complete dashboard HTML
 */
export function buildDashboardHtml(context: DashboardContext): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>aX Platform Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/flowbite/2.2.1/flowbite.min.css" rel="stylesheet" />
  <style>
    .task-card { transition: transform 0.2s, box-shadow 0.2s; }
    .task-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .badge-success { background-color: #10b981; color: white; }
    .badge-secondary { background-color: #6b7280; color: white; }
    .timeline-heartbeat { opacity: 0.7; }
  </style>
</head>
<body class="bg-gray-50 dark:bg-gray-900 min-h-screen">
  
  <!-- HEADER: Identity + Space + Permissions -->
  ${buildHeader(context)}
  
  <!-- CONTENT: Task Kanban -->
  <main class="container mx-auto px-4 py-6">
    ${buildKanban(context.tasks)}
  </main>
  
  <!-- FOOTER: Activity Pulse -->
  ${buildActivityPulse(context.recentActivity)}
  
  <script src="https://cdnjs.cloudflare.com/ajax/libs/flowbite/2.2.1/flowbite.min.js"></script>
  <script>
    // postMessage bridge for MCP App communication
    function callTool(toolName, params) {
      window.parent.postMessage({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: params }
      }, window.location.origin);
    }
    
    function completeTask(taskId) {
      callTool('ax_tasks', { action: 'update', task_id: taskId, status: 'completed' });
    }
    
    function assignTask(taskId) {
      callTool('ax_tasks', { action: 'assign', task_id: taskId });
    }

    // Event delegation for task action buttons (avoids inline onclick XSS risk)
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const taskId = btn.getAttribute('data-task-id');
      if (!taskId) return;
      if (action === 'complete') completeTask(taskId);
      else if (action === 'assign') assignTask(taskId);
    });
  </script>
</body>
</html>`;
}

function buildHeader(context: DashboardContext): string {
  const { identity, space, tools } = context;
  
  return `
  <header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
    <div class="container mx-auto px-4 py-3">
      <!-- Identity Row -->
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold">
            ${identity.handle?.charAt(1)?.toUpperCase() || 'A'}
          </div>
          <div>
            <h1 class="text-lg font-semibold text-gray-900 dark:text-white">${escapeHtml(identity.name || identity.handle)}</h1>
            <p class="text-sm text-gray-500 dark:text-gray-400">@${escapeHtml(identity.handle)} • ${escapeHtml(identity.specialization || 'Agent')}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
            <span class="w-2 h-2 mr-1 bg-green-500 rounded-full"></span>
            Online
          </span>
        </div>
      </div>
      
      <!-- Space Row -->
      <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 mb-3">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
        </svg>
        <span class="font-medium">${escapeHtml(space.name)}</span>
        ${space.description ? `<span class="text-gray-400">•</span><span>${escapeHtml(space.description)}</span>` : ''}
      </div>
      
      <!-- Permission Badges -->
      <div class="flex flex-wrap gap-2">
        ${tools.available.map(tool => `
          <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
            ✓ ${escapeHtml(tool)}
          </span>
        `).join('')}
        ${tools.restricted.map(tool => `
          <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
            ✗ ${escapeHtml(tool)}
          </span>
        `).join('')}
      </div>
    </div>
  </header>`;
}

function buildKanban(tasks: Task[]): string {
  const columns = {
    not_started: tasks.filter(t => t.status === 'not_started'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    completed: tasks.filter(t => t.status === 'completed'),
  };
  
  return `
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Backlog Column -->
    <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
      <h2 class="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
        <span class="w-3 h-3 bg-gray-400 rounded-full"></span>
        Backlog
        <span class="ml-auto text-sm text-gray-500">${columns.not_started.length}</span>
      </h2>
      <div class="space-y-3">
        ${columns.not_started.map(task => buildTaskCard(task)).join('')}
      </div>
    </div>
    
    <!-- In Progress Column -->
    <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
      <h2 class="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
        <span class="w-3 h-3 bg-blue-500 rounded-full"></span>
        In Progress
        <span class="ml-auto text-sm text-gray-500">${columns.in_progress.length}</span>
      </h2>
      <div class="space-y-3">
        ${columns.in_progress.map(task => buildTaskCard(task)).join('')}
      </div>
    </div>
    
    <!-- Done Column -->
    <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
      <h2 class="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
        <span class="w-3 h-3 bg-green-500 rounded-full"></span>
        Done
        <span class="ml-auto text-sm text-gray-500">${columns.completed.length}</span>
      </h2>
      <div class="space-y-3">
        ${columns.completed.slice(0, 5).map(task => buildTaskCard(task)).join('')}
        ${columns.completed.length > 5 ? `<p class="text-sm text-gray-500 text-center">+${columns.completed.length - 5} more</p>` : ''}
      </div>
    </div>
  </div>`;
}

function buildTaskCard(task: Task): string {
  const priorityColors: Record<string, string> = {
    urgent: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
    medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    low: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };
  
  return `
  <div class="task-card bg-gray-50 dark:bg-gray-700 rounded-lg p-3 border border-gray-200 dark:border-gray-600">
    <div class="flex items-start justify-between mb-2">
      <span class="text-xs font-mono text-gray-400">${escapeHtml(task.id.slice(0, 8))}</span>
      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${priorityColors[task.priority] || priorityColors.medium}">
        ${escapeHtml(task.priority)}
      </span>
    </div>
    <h3 class="text-sm font-medium text-gray-900 dark:text-white mb-1">${escapeHtml(task.title)}</h3>
    ${task.description ? `<p class="text-xs text-gray-500 dark:text-gray-400 mb-2 line-clamp-2">${escapeHtml(task.description)}</p>` : ''}
    ${task.status !== 'completed' ? `
    <div class="flex gap-2 mt-2">
      <button data-action="complete" data-task-id="${escapeHtml(task.id)}" class="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">
        Complete
      </button>
      ${!task.assignedTo ? `
      <button data-action="assign" data-task-id="${escapeHtml(task.id)}" class="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">
        Assign
      </button>
      ` : ''}
    </div>
    ` : ''}
  </div>`;
}

function buildActivityPulse(activities: ActivityBreadcrumb[]): string {
  if (activities.length === 0) {
    return `
    <footer class="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-3">
      <div class="container mx-auto text-center text-sm text-gray-500">
        No recent activity
      </div>
    </footer>`;
  }
  
  return `
  <footer class="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-3">
    <div class="container mx-auto">
      <h3 class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Recent Activity</h3>
      <div class="flex gap-4 overflow-x-auto pb-1">
        ${activities.slice(0, 5).map(activity => buildActivityItem(activity)).join('')}
      </div>
    </div>
  </footer>`;
}

function buildActivityItem(activity: ActivityBreadcrumb): string {
  const statusIcons: Record<string, string> = {
    success: '✓',
    info: 'ℹ',
    warning: '⚠',
  };
  
  const isHeartbeat = activity.source === 'heartbeat';
  
  return `
  <div class="flex items-center gap-2 text-sm whitespace-nowrap ${isHeartbeat ? 'timeline-heartbeat' : ''}">
    <span class="text-gray-400">${statusIcons[activity.status] || '•'}</span>
    <span class="text-gray-600 dark:text-gray-300">${escapeHtml(activity.action)}</span>
    <span class="text-xs text-gray-400">${formatTimestamp(activity.timestamp)}</span>
  </div>`;
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text?.replace(/[&<>"']/g, m => map[m]) || '';
}
