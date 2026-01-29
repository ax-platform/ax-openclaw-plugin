#!/bin/bash
# Add an aX agent to the gateway configuration
# Usage: ./add-agent.sh <agent_id> <secret> <handle> <env>
# Example: ./add-agent.sh ba18f866-... mysecret @clawd_420 local

set -e

PLIST="$HOME/Library/LaunchAgents/com.clawdbot.gateway.plist"

if [ $# -lt 4 ]; then
    echo "Usage: $0 <agent_id> <secret> <handle> <env>"
    echo ""
    echo "Arguments:"
    echo "  agent_id  - UUID from aX registration"
    echo "  secret    - Webhook secret from aX registration"
    echo "  handle    - Agent @handle (e.g., @clawdbot)"
    echo "  env       - Environment label (e.g., prod, local, dev)"
    echo ""
    echo "Example:"
    echo "  $0 ba18f866-ece3-4a5e-a4b5-b5cad99f7d80 mysecret @clawd_420 local"
    exit 1
fi

AGENT_ID="$1"
SECRET="$2"
HANDLE="$3"
ENV="$4"

# Check if plist exists
if [ ! -f "$PLIST" ]; then
    echo "Error: Gateway plist not found at $PLIST"
    echo "Make sure clawdbot gateway is installed."
    exit 1
fi

# Convert to XML for editing
plutil -convert xml1 "$PLIST"

# Get current AX_AGENTS or initialize empty array
CURRENT=$(plutil -extract EnvironmentVariables.AX_AGENTS raw "$PLIST" 2>/dev/null || echo "[]")

# Build new agent entry
NEW_ENTRY="{\"id\":\"$AGENT_ID\",\"secret\":\"$SECRET\",\"handle\":\"$HANDLE\",\"env\":\"$ENV\"}"

# Check if agent already exists
if echo "$CURRENT" | grep -q "\"$AGENT_ID\""; then
    echo "Agent $AGENT_ID already exists in config. Updating..."
    # Remove old entry and add new one
    CURRENT=$(echo "$CURRENT" | sed "s/{[^}]*\"id\":\"$AGENT_ID\"[^}]*}/$NEW_ENTRY/g")
else
    # Add to array
    if [ "$CURRENT" = "[]" ]; then
        CURRENT="[$NEW_ENTRY]"
    else
        # Remove trailing ] and add new entry
        CURRENT="${CURRENT%]}, $NEW_ENTRY]"
    fi
fi

# Write back to plist using Python for reliable JSON handling
python3 << EOF
import plistlib
import json

plist_path = "$PLIST"
new_agents = json.loads('''$CURRENT''')

with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)

# Update AX_AGENTS
plist['EnvironmentVariables']['AX_AGENTS'] = json.dumps(new_agents)

# Also set fallback vars to first agent if not already set
if 'AX_AGENT_ID' not in plist['EnvironmentVariables'] or not plist['EnvironmentVariables']['AX_AGENT_ID']:
    plist['EnvironmentVariables']['AX_AGENT_ID'] = new_agents[0]['id']
    plist['EnvironmentVariables']['AX_WEBHOOK_SECRET'] = new_agents[0]['secret']

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f)

print(f"Updated AX_AGENTS with {len(new_agents)} agent(s)")
for agent in new_agents:
    print(f"  {agent.get('handle', '(no handle)')} [{agent.get('env', 'unknown')}] -> {agent['id'][:8]}...")
EOF

echo ""
echo "Restart gateway to apply changes:"
echo "  launchctl unload ~/Library/LaunchAgents/com.clawdbot.gateway.plist"
echo "  launchctl load ~/Library/LaunchAgents/com.clawdbot.gateway.plist"
