#!/bin/bash
# List configured aX agents
# Usage: ./list-agents.sh

PLIST="$HOME/Library/LaunchAgents/com.clawdbot.gateway.plist"

if [ ! -f "$PLIST" ]; then
    echo "Error: Gateway plist not found at $PLIST"
    exit 1
fi

echo "Configured aX Agents:"
echo "====================="

# Get AX_AGENTS value
AGENTS=$(plutil -extract EnvironmentVariables.AX_AGENTS raw "$PLIST" 2>/dev/null || echo "[]")

if [ "$AGENTS" = "[]" ] || [ -z "$AGENTS" ]; then
    # Check for single-agent fallback
    AGENT_ID=$(plutil -extract EnvironmentVariables.AX_AGENT_ID raw "$PLIST" 2>/dev/null || echo "")
    if [ -n "$AGENT_ID" ]; then
        echo "  (single-agent mode)"
        echo "  ID: ${AGENT_ID:0:8}..."
    else
        echo "  No agents configured."
        echo ""
        echo "Add an agent with:"
        echo "  ./scripts/add-agent.sh <id> <secret> <handle> <env>"
    fi
else
    # Parse and display JSON
    python3 << EOF
import json
try:
    agents = json.loads('''$AGENTS''')
    for agent in agents:
        handle = agent.get('handle', '(no handle)')
        env = agent.get('env', 'unknown')
        id_preview = agent['id'][:8] + '...'
        url = agent.get('url', '')
        print(f"  {handle} [{env}]")
        print(f"    ID: {id_preview}")
        if url:
            print(f"    URL: {url}")
        print()
except json.JSONDecodeError as e:
    print(f"  Error parsing AX_AGENTS: {e}")
EOF
fi

echo ""
echo "Gateway status:"
launchctl list | grep clawdbot || echo "  Not running"
