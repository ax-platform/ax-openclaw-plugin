#!/bin/bash
# ax-clawdbot Setup Script
#
# Usage:
#   ./setup.sh              - Sync secrets and restart gateway
#   ./setup.sh sync         - Same as above (explicit)
#   ./setup.sh clean        - Clean install (remove old, reinstall)
#   ./setup.sh secret ID SECRET - Update a single agent's secret
#   ./setup.sh add ID SECRET HANDLE ENV - Add a new agent
#   ./setup.sh remove ID    - Remove an agent
#   ./setup.sh list         - List configured agents
#   ./setup.sh restart      - Just restart gateway
#   ./setup.sh logs         - Tail gateway logs
#   ./setup.sh status       - Check tunnel and gateway status
#   ./setup.sh help         - Show help
#
# Secrets source: ax-agents.env (format: AGENT_N=id|secret|handle|env)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/ax-agents.env"
# Support both openclaw (new) and clawdbot (legacy)
if command -v openclaw &> /dev/null; then
    CLI_CMD="openclaw"
    CONFIG_DIR="$HOME/.openclaw"
    CONFIG_FILE="$CONFIG_DIR/openclaw.json"
    LAUNCH_AGENT="ai.openclaw.gateway"
elif command -v clawdbot &> /dev/null; then
    CLI_CMD="clawdbot"
    CONFIG_DIR="$HOME/.clawdbot"
    CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
    LAUNCH_AGENT="com.clawdbot.gateway"
else
    echo "ERROR: Neither openclaw nor clawdbot found in PATH"
    exit 1
fi
EXTENSION_DIR="$CONFIG_DIR/extensions/ax-platform"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
    echo -e "${CYAN}ax-clawdbot Setup Script${NC}"
    echo ""
    echo "Usage: ./setup.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  sync              Sync ax-agents.env to clawdbot.json and restart"
    echo "  clean             Clean install - remove old config, reinstall plugin"
    echo "  secret ID SECRET  Update secret for agent ID"
    echo "  add ID SECRET HANDLE ENV  Add new agent to ax-agents.env"
    echo "  remove ID         Remove agent from ax-agents.env"
    echo "  list              List all configured agents"
    echo "  restart           Restart gateway (quick)"
    echo "  reload            Reload gateway (full plist reload)"
    echo "  logs              Tail gateway logs (Ctrl+C to exit)"
    echo "  status            Check gateway and tunnel status"
    echo "  help              Show this help"
    echo ""
    echo "Examples:"
    echo "  ./setup.sh sync"
    echo "  ./setup.sh secret e5c6041a-824c-4216-8520-1d928fe6f789 newSecretHere"
    echo "  ./setup.sh add uuid-here secret-here @myagent prod"
    echo ""
    echo "Config file: ax-agents.env"
    echo "Format: AGENT_N=id|secret|handle|env"
    echo ""
    echo "Note: Sync automatically cleans stale AX_* env vars from the LaunchAgent plist"
    echo "      to prevent signature verification failures."
}

check_deps() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required. Install with: brew install jq"
        exit 1
    fi
}

check_env_file() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error "$ENV_FILE not found"
        echo ""
        echo "Create ax-agents.env with your agent credentials:"
        echo ""
        echo "  # ax-clawdbot Agent Configuration"
        echo "  # Format: AGENT_N=id|secret|handle|env"
        echo "  AGENT_1=your-agent-uuid|your-webhook-secret|@youragent|prod"
        echo ""
        exit 1
    fi
}

check_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_error "$CONFIG_FILE not found. Is OpenClaw/Clawdbot installed?"
        exit 1
    fi
}

# Parse agents from env file into JSON
parse_agents() {
    local agents_json="[]"
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*#.*$ ]] && continue
        [[ -z "${line// }" ]] && continue

        if [[ "$line" =~ ^AGENT_[0-9]+=(.+)$ ]]; then
            value="${BASH_REMATCH[1]}"
            IFS='|' read -r id secret handle env <<< "$value"

            if [[ -n "$id" && -n "$secret" ]]; then
                agent_obj=$(jq -n \
                    --arg id "$id" \
                    --arg secret "$secret" \
                    --arg handle "$handle" \
                    --arg env "$env" \
                    '{id: $id, secret: $secret, handle: $handle, env: $env}')
                agents_json=$(echo "$agents_json" | jq --argjson agent "$agent_obj" '. + [$agent]')
            fi
        fi
    done < "$ENV_FILE"
    echo "$agents_json"
}

# Sync env file to clawdbot.json and restart
cmd_sync() {
    check_deps
    check_env_file
    check_config

    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  ax-clawdbot Sync${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    log_info "Reading agents from ax-agents.env..."
    AGENTS_JSON=$(parse_agents)
    AGENT_COUNT=$(echo "$AGENTS_JSON" | jq 'length')

    # Display agents
    echo "$AGENTS_JSON" | jq -r '.[] | "  \(.handle // "unknown") [\(.env // "default")] -> \(.id[0:8])..."'

    if [[ "$AGENT_COUNT" -eq 0 ]]; then
        log_error "No agents found in ax-agents.env"
        exit 1
    fi

    log_ok "Found $AGENT_COUNT agent(s)"

    # Clean reinstall: remove old extension and clear config entries first
    log_info "Reinstalling extension..."
    rm -rf "$EXTENSION_DIR" 2>/dev/null || true
    # Clear config entries to avoid validation error during install
    TEMP_CONFIG=$(cat "$CONFIG_FILE" | jq 'del(.plugins.entries["ax-platform"]) | del(.plugins.installs["ax-platform"])')
    echo "$TEMP_CONFIG" > "$CONFIG_FILE"
    cd "$SCRIPT_DIR/extension"
    if $CLI_CMD plugins install . 2>&1 | grep -v "^\\[" | head -5; then
        log_ok "Extension installed"
    else
        log_warn "Extension install had warnings (check logs)"
    fi
    cd "$SCRIPT_DIR"

    log_info "Updating clawdbot.json..."
    # Resolve outbound token file (first .ax-token.json found in workspaces)
    local token_file=""
    for ws in "$CONFIG_DIR/workspaces"/*/.ax-token.json; do
        if [[ -f "$ws" ]]; then
            token_file="$ws"
            break
        fi
    done

    UPDATED_CONFIG=$(cat "$CONFIG_FILE" | jq --argjson agents "$AGENTS_JSON" --arg tokenFile "${token_file}" '
        .plugins.entries["ax-platform"].enabled = true |
        .plugins.entries["ax-platform"].config.agents = $agents |
        .plugins.entries["ax-platform"].config.backendUrl = "https://api.paxai.app" |
        .plugins.entries["ax-platform"].config.outbound.mcpEndpoint = "https://mcp.paxai.app" |
        if $tokenFile != "" then .plugins.entries["ax-platform"].config.outbound.tokenFile = $tokenFile else . end
    ')
    echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
    if [[ -n "$token_file" ]]; then
        log_ok "Updated plugin config (outbound token: ${token_file##*/workspaces/})"
    else
        log_warn "Updated plugin config (no .ax-token.json found for outbound)"
    fi

    # Provision agent directories and config entries
    # Each agent needs its own agentDir (sessions/models) and workspace to avoid
    # routing to "main" and DuplicateAgentDirError when multiple agents share a dir
    if [[ "$AGENT_COUNT" -gt 0 ]]; then
        log_info "Provisioning agent directories..."
        local agents_dir="$CONFIG_DIR/agents"
        local workspaces_dir="$CONFIG_DIR/workspaces"
        local main_models="$agents_dir/main/agent/models.json"

        local agents_list_json="[]"
        for handle_raw in $(echo "$AGENTS_JSON" | jq -r '.[].handle // "@agent"'); do
            local agent_name="${handle_raw#@}"
            local agent_dir="$agents_dir/$agent_name/agent"
            local workspace_dir="$workspaces_dir/$agent_name"

            mkdir -p "$agent_dir" "$workspace_dir"

            # Copy models.json from main agent if available and not already present
            if [[ -f "$main_models" && ! -f "$agent_dir/models.json" ]]; then
                cp "$main_models" "$agent_dir/models.json"
            fi

            agents_list_json=$(echo "$agents_list_json" | jq \
                --arg id "$agent_name" \
                --arg ws "$workspace_dir" \
                --arg ad "$agent_dir" \
                '. + [{id: $id, name: $id, workspace: $ws, agentDir: $ad}]')
        done

        # Update agents.list: keep "main" entry, replace agent entries
        UPDATED_CONFIG=$(cat "$CONFIG_FILE" | jq --argjson list "$agents_list_json" '
            .agents.list = ([(.agents.list // [])[] | select(.id == "main")] + $list)
        ')
        echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
        log_ok "Provisioned $AGENT_COUNT agent workspace(s)"

        # Generate top-level bindings for multi-agent routing
        # Without bindings, all agents route to "main"
        log_info "Generating agent bindings..."
        local bindings_json
        bindings_json=$(echo "$AGENTS_JSON" | jq '[.[] | {
            match: {channel: "ax-platform", accountId: (.handle // "@agent" | ltrimstr("@"))},
            agentId: (.handle // "@agent" | ltrimstr("@"))
        }]')
        UPDATED_CONFIG=$(cat "$CONFIG_FILE" | jq --argjson bindings "$bindings_json" '.bindings = $bindings')
        echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
        log_ok "Generated $AGENT_COUNT binding(s) for multi-agent routing"
    fi

    # Clean stale env vars from plist (prevents signature verification failures)
    # Only applies to macOS (launchctl); Linux uses systemd
    if [[ "$(uname)" == "Darwin" ]]; then
        if clean_plist_env; then
            cmd_restart_quiet
        else
            # Plist was modified - need full reload
            cmd_reload
        fi
    else
        cmd_restart_quiet
    fi

    cmd_verify
}

# Clean install
cmd_clean() {
    check_deps
    check_env_file
    check_config

    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  ax-clawdbot Clean Install${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    if [[ -d "$EXTENSION_DIR" ]]; then
        log_info "Removing old extension at $EXTENSION_DIR"
        rm -rf "$EXTENSION_DIR"
    fi

    log_info "Clearing plugin config from clawdbot.json"
    CLEARED_CONFIG=$(cat "$CONFIG_FILE" | jq '
        del(.plugins.entries["ax-platform"]) |
        del(.plugins.installs["ax-platform"])
    ')
    echo "$CLEARED_CONFIG" > "$CONFIG_FILE"

    log_info "Reinstalling plugin..."
    cd "$SCRIPT_DIR/extension"
    $CLI_CMD plugins install . 2>&1 | grep -v "^\[" || true
    cd "$SCRIPT_DIR"

    log_ok "Clean install complete"
    echo ""

    # Now sync
    cmd_sync
}

# Update a single agent's secret
cmd_secret() {
    local agent_id="$1"
    local new_secret="$2"

    if [[ -z "$agent_id" || -z "$new_secret" ]]; then
        log_error "Usage: ./setup.sh secret <agent_id> <new_secret>"
        exit 1
    fi

    check_env_file

    echo ""
    log_info "Updating secret for agent ${agent_id:0:8}..."

    # Find and update the agent in ax-agents.env
    local found=false
    local temp_file=$(mktemp)

    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^(AGENT_[0-9]+)=([^|]+)\|([^|]+)\|([^|]*)\|(.*)$ ]]; then
            local var_name="${BASH_REMATCH[1]}"
            local id="${BASH_REMATCH[2]}"
            local old_secret="${BASH_REMATCH[3]}"
            local handle="${BASH_REMATCH[4]}"
            local env="${BASH_REMATCH[5]}"

            if [[ "$id" == "$agent_id" ]]; then
                echo "${var_name}=${id}|${new_secret}|${handle}|${env}" >> "$temp_file"
                log_ok "Updated secret for ${handle:-$id}"
                found=true
            else
                echo "$line" >> "$temp_file"
            fi
        else
            echo "$line" >> "$temp_file"
        fi
    done < "$ENV_FILE"

    if [[ "$found" == true ]]; then
        mv "$temp_file" "$ENV_FILE"
        echo ""
        log_info "Now run './setup.sh sync' to apply changes"
    else
        rm "$temp_file"
        log_error "Agent $agent_id not found in ax-agents.env"
        exit 1
    fi
}

# Add new agent
cmd_add() {
    local id="$1"
    local secret="$2"
    local handle="$3"
    local env="$4"

    if [[ -z "$id" || -z "$secret" ]]; then
        log_error "Usage: ./setup.sh add <id> <secret> [handle] [env]"
        exit 1
    fi

    # Find next agent number
    local max_num=0
    if [[ -f "$ENV_FILE" ]]; then
        while IFS= read -r line; do
            if [[ "$line" =~ ^AGENT_([0-9]+)= ]]; then
                local num="${BASH_REMATCH[1]}"
                if (( num > max_num )); then
                    max_num=$num
                fi
            fi
        done < "$ENV_FILE"
    fi

    local next_num=$((max_num + 1))

    echo "AGENT_${next_num}=${id}|${secret}|${handle:-@agent}|${env:-prod}" >> "$ENV_FILE"

    log_ok "Added agent ${handle:-$id} as AGENT_${next_num}"
    echo ""
    log_info "Run './setup.sh sync' to apply changes"
}

# Remove agent
cmd_remove() {
    local agent_id="$1"

    if [[ -z "$agent_id" ]]; then
        log_error "Usage: ./setup.sh remove <agent_id>"
        exit 1
    fi

    check_env_file

    local temp_file=$(mktemp)
    local found=false

    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^AGENT_[0-9]+=([^|]+)\| && "${BASH_REMATCH[1]}" == "$agent_id" ]]; then
            log_ok "Removed agent $agent_id"
            found=true
        else
            echo "$line" >> "$temp_file"
        fi
    done < "$ENV_FILE"

    if [[ "$found" == true ]]; then
        mv "$temp_file" "$ENV_FILE"
        log_info "Run './setup.sh sync' to apply changes"
    else
        rm "$temp_file"
        log_error "Agent $agent_id not found"
        exit 1
    fi
}

# List agents
cmd_list() {
    check_env_file

    echo ""
    echo -e "${CYAN}Configured Agents (ax-agents.env):${NC}"
    echo ""

    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^AGENT_([0-9]+)=([^|]+)\|([^|]+)\|([^|]*)\|(.*)$ ]]; then
            local num="${BASH_REMATCH[1]}"
            local id="${BASH_REMATCH[2]}"
            local secret="${BASH_REMATCH[3]}"
            local handle="${BASH_REMATCH[4]}"
            local env="${BASH_REMATCH[5]}"

            echo -e "  ${GREEN}${handle:-unknown}${NC} [${env:-default}]"
            echo "    ID: ${id:0:8}..."
            echo "    Secret: ${secret:0:8}..."
            echo ""
        fi
    done < "$ENV_FILE"
}

# Clean up stale AX_* env vars from LaunchAgent plist
# These can override clawdbot.json config and cause signature verification failures
clean_plist_env() {
    local plist_file="$HOME/Library/LaunchAgents/${LAUNCH_AGENT}.plist"

    if [[ ! -f "$plist_file" ]]; then
        return 0  # No plist to clean
    fi

    # Check if plist contains any AX_ env vars
    if grep -q "AX_AGENTS\|AX_AGENT_ID\|AX_WEBHOOK_SECRET" "$plist_file" 2>/dev/null; then
        log_info "Removing stale AX_* env vars from LaunchAgent plist..."

        # Use PlistBuddy to remove the keys (macOS native tool)
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_AGENTS" "$plist_file" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_AGENT_ID" "$plist_file" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_WEBHOOK_SECRET" "$plist_file" 2>/dev/null || true

        log_ok "Cleaned plist env vars (secrets now come from clawdbot.json only)"
        return 1  # Signal that plist was modified
    fi

    return 0  # No changes needed
}

# Restart gateway (with full reload if plist changed)
cmd_restart() {
    log_info "Restarting gateway..."
    if [[ "$(uname)" == "Darwin" ]]; then
        launchctl stop $LAUNCH_AGENT 2>/dev/null || true
        sleep 2
        launchctl start $LAUNCH_AGENT
    else
        sudo systemctl restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        systemctl --user restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        { log_warn "Could not restart via systemctl. Restart manually."; return; }
    fi
    sleep 3
    log_ok "Gateway restarted"
    cmd_verify
}

# Full reload (unload/load) - needed when plist changes (macOS only)
cmd_reload() {
    log_info "Reloading gateway..."
    if [[ "$(uname)" == "Darwin" ]]; then
        launchctl unload ~/Library/LaunchAgents/${LAUNCH_AGENT}.plist 2>/dev/null || true
        sleep 2
        launchctl load ~/Library/LaunchAgents/${LAUNCH_AGENT}.plist 2>/dev/null || true
    else
        sudo systemctl daemon-reload 2>/dev/null || true
        sudo systemctl restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        systemctl --user restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        { log_warn "Could not reload via systemctl. Restart manually."; return; }
    fi
    sleep 3
    log_ok "Gateway reloaded"
}

cmd_restart_quiet() {
    log_info "Restarting gateway..."
    if [[ "$(uname)" == "Darwin" ]]; then
        launchctl stop $LAUNCH_AGENT 2>/dev/null || true
        sleep 2
        launchctl start $LAUNCH_AGENT
    else
        sudo systemctl restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        systemctl --user restart ${LAUNCH_AGENT}.service 2>/dev/null || \
        { log_warn "Could not restart via systemctl. Restart manually."; return; }
    fi
    sleep 3
    log_ok "Gateway restarted"
}

# Verify registration
cmd_verify() {
    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  Verification${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    if tail -30 "$CONFIG_DIR/logs/gateway.log" 2>/dev/null | grep -q "ax-platform.*Registered agents"; then
        tail -30 "$CONFIG_DIR/logs/gateway.log" | grep "ax-platform" | grep -E "Registered|@" | tail -5
        echo ""
        log_ok "Setup complete!"
    else
        log_warn "Could not verify registration. Check logs:"
        echo "  tail -f $CONFIG_DIR/logs/gateway.log | grep ax-platform"
    fi
    echo ""
}

# Tail logs
cmd_logs() {
    log_info "Tailing gateway logs (Ctrl+C to exit)..."
    echo ""
    tail -f "$CONFIG_DIR/logs/gateway.log" | grep --line-buffered "ax-platform"
}

# Check status
cmd_status() {
    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  Status${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    # Gateway
    if pgrep -f "(clawdbot|openclaw).*gateway" > /dev/null; then
        log_ok "Gateway: Running"
    else
        log_error "Gateway: Not running"
    fi

    # Cloudflare tunnel
    if pgrep -f cloudflared > /dev/null; then
        local tunnel_url=$(grep trycloudflare /tmp/cf-tunnel.log 2>/dev/null | grep -oE 'https://[^|]+trycloudflare.com' | head -1)
        if [[ -n "$tunnel_url" ]]; then
            log_ok "Tunnel: $tunnel_url"
        else
            log_warn "Tunnel: Running but URL unknown"
        fi
    else
        log_warn "Tunnel: Not running"
    fi

    # Agents in config
    if [[ -f "$ENV_FILE" ]]; then
        local count=$(grep -c "^AGENT_" "$ENV_FILE" 2>/dev/null || echo 0)
        log_info "Agents configured: $count"
    fi

    echo ""
}

# Main
case "${1:-sync}" in
    sync)       cmd_sync ;;
    clean)      cmd_clean ;;
    secret)     cmd_secret "$2" "$3" ;;
    add)        cmd_add "$2" "$3" "$4" "$5" ;;
    remove)     cmd_remove "$2" ;;
    list)       cmd_list ;;
    restart)    cmd_restart ;;
    reload)     cmd_reload; cmd_verify ;;
    logs)       cmd_logs ;;
    status)     cmd_status ;;
    help|--help|-h) usage ;;
    *)          log_error "Unknown command: $1"; usage; exit 1 ;;
esac
