#!/bin/bash
# ax-clawdbot Setup Script
# Reads ax-agents.env and configures the gateway
#
# Usage:
#   1. Copy ax-agents.env.example to ax-agents.env
#   2. Fill in your agent details
#   3. Run: ./scripts/setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${1:-$REPO_DIR/ax-agents.env}"
PLIST="$HOME/Library/LaunchAgents/com.clawdbot.gateway.plist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  ax-clawdbot Setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check for config file
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$REPO_DIR/ax-agents.env.example" ]; then
        echo -e "${YELLOW}Config file not found: $CONFIG_FILE${NC}"
        echo ""
        echo "To get started:"
        echo "  1. cp ax-agents.env.example ax-agents.env"
        echo "  2. Edit ax-agents.env with your agent details"
        echo "  3. Run this script again"
        echo ""
        echo -e "${BLUE}Need to register an agent?${NC}"
        echo "  → https://paxai.app/register"
        exit 1
    else
        echo -e "${RED}Error: Config file not found: $CONFIG_FILE${NC}"
        exit 1
    fi
fi

echo -e "Reading config from: ${GREEN}$CONFIG_FILE${NC}"
echo ""

# Check for plist
if [ ! -f "$PLIST" ]; then
    echo -e "${RED}Error: Gateway plist not found at $PLIST${NC}"
    echo "Make sure clawdbot gateway is installed first."
    exit 1
fi

# Parse .env file and build JSON
# Format: AGENT_N=id|secret|handle|env
AGENTS_JSON="["
FIRST=true
AGENT_COUNT=0

while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ ]] && continue
    [[ -z "$line" ]] && continue

    # Match AGENT_N=value
    if [[ "$line" =~ ^AGENT_[0-9]+=(.+)$ ]]; then
        VALUE="${BASH_REMATCH[1]}"

        # Parse pipe-separated values: id|secret|handle|env
        IFS='|' read -r ID SECRET HANDLE ENV <<< "$VALUE"

        # Skip placeholder
        [[ "$ID" == "your-agent-uuid" ]] && continue
        [[ -z "$ID" || -z "$SECRET" ]] && continue

        # Build JSON entry
        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            AGENTS_JSON+=","
        fi

        AGENTS_JSON+="{\"id\":\"$ID\",\"secret\":\"$SECRET\""
        [ -n "$HANDLE" ] && AGENTS_JSON+=",\"handle\":\"$HANDLE\""
        [ -n "$ENV" ] && AGENTS_JSON+=",\"env\":\"$ENV\""
        AGENTS_JSON+="}"

        AGENT_COUNT=$((AGENT_COUNT + 1))

        # Display
        HANDLE_DISPLAY="${HANDLE:-(no handle)}"
        ENV_DISPLAY="${ENV:-unknown}"
        ID_PREVIEW="${ID:0:8}..."
        echo "  $HANDLE_DISPLAY [$ENV_DISPLAY] → $ID_PREVIEW"
    fi
done < "$CONFIG_FILE"

AGENTS_JSON+="]"

if [ "$AGENT_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}No agents found in config file.${NC}"
    echo ""
    echo "Make sure your ax-agents.env has entries like:"
    echo "  AGENT_1=uuid|secret|@handle|env"
    exit 1
fi

echo ""
echo -e "Found ${GREEN}$AGENT_COUNT${NC} agent(s)"
echo ""

# Confirm
read -p "Apply this configuration? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo -e "${BLUE}Applying configuration...${NC}"

# Convert plist to XML for editing
plutil -convert xml1 "$PLIST"

# Update plist using Python (plistlib is built-in)
python3 << EOF
import plistlib
import json

plist_path = "$PLIST"
agents = json.loads('''$AGENTS_JSON''')

with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)

# Set AX_AGENTS
plist['EnvironmentVariables']['AX_AGENTS'] = json.dumps(agents)

# Set fallback vars to first agent
if agents:
    plist['EnvironmentVariables']['AX_AGENT_ID'] = agents[0]['id']
    plist['EnvironmentVariables']['AX_WEBHOOK_SECRET'] = agents[0]['secret']

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f)

print("✓ Updated gateway configuration")
EOF

# Restart gateway
echo -e "${BLUE}Restarting gateway...${NC}"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 2

# Verify
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Your agents are now configured. Next steps:"
echo ""
echo "  1. Start your tunnel (if not running):"
echo "     cloudflared tunnel --url http://localhost:18789"
echo ""
echo "  2. Make sure your webhook URL is registered at paxai.app"
echo ""
echo "  3. Test by @mentioning your agent in aX!"
echo ""
echo "View configured agents anytime:"
echo "  ./scripts/list-agents.sh"
echo ""
