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
#
# SAFETY: sync only updates plugin agent credentials and ensures agent/binding
# entries exist. It never overwrites backendUrl, outbound config, workspace paths,
# heartbeat config, model settings, or other user-managed config.

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
    echo "  sync              Sync ax-agents.env credentials to config and restart"
    echo "  clean             Clean install - remove old extension, reinstall, sync"
    echo "  secret ID SECRET  Update secret for agent ID"
    echo "  add ID SECRET HANDLE ENV  Add new agent to ax-agents.env"
    echo "  remove ID         Remove agent from ax-agents.env"
    echo "  list              List all configured agents"
    echo "  restart           Restart gateway"
    echo "  logs              Tail gateway logs (Ctrl+C to exit)"
    echo "  status            Check gateway and tunnel status"
    echo "  help              Show this help"
    echo ""
    echo "Config file: ax-agents.env"
    echo "Format: AGENT_N=id|secret|handle|env"
    echo ""
    echo "Note: sync only updates agent credentials. It preserves all other config"
    echo "      (backendUrl, outbound, workspace paths, heartbeat, models, etc)."
}

check_deps() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required. Install with: brew install jq (macOS) or apt install jq (Linux)"
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

# Create timestamped backup of config before any modifications
backup_config() {
    local backup_dir="$CONFIG_DIR/backups"
    mkdir -p "$backup_dir"
    local timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    local backup_file="$backup_dir/config-backup-${timestamp}.json"
    cp "$CONFIG_FILE" "$backup_file"
    log_info "Config backed up to $backup_file"
    # Keep only last 10 backups
    ls -t "$backup_dir"/config-backup-*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
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

# Copy extension files from source to install directory (non-destructive)
# Copies over existing files without deleting the directory first
update_extension() {
    local source_dir="$SCRIPT_DIR/extension"
    if [[ ! -d "$source_dir" ]]; then
        log_error "Extension source not found at $source_dir"
        return 1
    fi

    mkdir -p "$EXTENSION_DIR"
    # rsync if available (preserves structure, handles deletions cleanly)
    if command -v rsync &> /dev/null; then
        rsync -a --delete "$source_dir/" "$EXTENSION_DIR/"
    else
        # Fallback: copy over
        cp -r "$source_dir/"* "$EXTENSION_DIR/"
    fi

    # Install dependencies if package.json exists
    if [[ -f "$EXTENSION_DIR/package.json" ]]; then
        log_info "Installing dependencies..."
        (cd "$EXTENSION_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1) || {
            log_warn "npm install had warnings (non-fatal)"
        }
        log_ok "Dependencies installed"
    fi

    # Ensure installs manifest exists in config
    local has_install=$(jq -r '.plugins.installs["ax-platform"] // empty' "$CONFIG_FILE")
    if [[ -z "$has_install" ]]; then
        local updated
        updated=$(jq --arg src "$source_dir" --arg dst "$EXTENSION_DIR" '
            .plugins.installs["ax-platform"] = {
                source: "path",
                sourcePath: $src,
                installPath: $dst,
                version: "0.2.0",
                installedAt: (now | strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            }
        ' "$CONFIG_FILE")
        echo "$updated" > "$CONFIG_FILE"
    fi

    log_ok "Extension updated at $EXTENSION_DIR"
}

# Sync env file to config and restart
# SAFETY: Only updates plugin agent credentials. Preserves all other config.
cmd_sync() {
    check_deps
    check_env_file
    check_config

    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  ax-clawdbot Sync${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    # Back up config before any changes
    backup_config

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

    # Update extension files (non-destructive copy)
    log_info "Updating extension files..."
    update_extension

    # Update ONLY the agent credentials in plugin config
    # Preserves: backendUrl, outbound config, and everything else
    log_info "Updating agent credentials..."
    UPDATED_CONFIG=$(jq --argjson agents "$AGENTS_JSON" '
        .plugins.entries["ax-platform"].enabled = true |
        .plugins.entries["ax-platform"].config.agents = $agents
    ' "$CONFIG_FILE")
    echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
    log_ok "Updated agent credentials (other plugin config preserved)"

    # Ensure each agent has an entry in agents.list (merge, don't replace)
    # Only adds missing entries — never overwrites existing workspace, model,
    # heartbeat, or other per-agent config
    log_info "Ensuring agent entries exist..."
    local agents_added=0
    for handle_raw in $(echo "$AGENTS_JSON" | jq -r '.[].handle // "@agent"'); do
        local agent_name="${handle_raw#@}"
        local has_entry
        has_entry=$(jq --arg id "$agent_name" '.agents.list // [] | map(select(.id == $id)) | length' "$CONFIG_FILE")

        if [[ "$has_entry" -eq 0 ]]; then
            local agents_dir="$CONFIG_DIR/agents"
            local agent_dir="$agents_dir/$agent_name/agent"
            local workspace_dir="$CONFIG_DIR/workspaces/$agent_name"
            mkdir -p "$agent_dir" "$workspace_dir"

            # Copy models.json from main agent if available
            local main_models="$agents_dir/main/agent/models.json"
            if [[ -f "$main_models" && ! -f "$agent_dir/models.json" ]]; then
                cp "$main_models" "$agent_dir/models.json"
            fi

            UPDATED_CONFIG=$(jq --arg id "$agent_name" --arg ws "$workspace_dir" --arg ad "$agent_dir" '
                .agents.list += [{id: $id, name: $id, workspace: $ws, agentDir: $ad}]
            ' "$CONFIG_FILE")
            echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
            agents_added=$((agents_added + 1))
            log_info "  Added new agent entry: $agent_name"
        fi
    done
    if [[ "$agents_added" -eq 0 ]]; then
        log_ok "All agent entries already exist (no changes)"
    else
        log_ok "Added $agents_added new agent entry/entries"
    fi

    # Ensure each agent has a binding (merge, don't replace)
    log_info "Ensuring agent bindings exist..."
    local bindings_added=0
    for handle_raw in $(echo "$AGENTS_JSON" | jq -r '.[].handle // "@agent"'); do
        local agent_name="${handle_raw#@}"
        local has_binding
        has_binding=$(jq --arg id "$agent_name" '
            .bindings // [] | map(select(.match.channel == "ax-platform" and .match.accountId == $id)) | length
        ' "$CONFIG_FILE")

        if [[ "$has_binding" -eq 0 ]]; then
            UPDATED_CONFIG=$(jq --arg id "$agent_name" '
                .bindings += [{match: {channel: "ax-platform", accountId: $id}, agentId: $id}]
            ' "$CONFIG_FILE")
            echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
            bindings_added=$((bindings_added + 1))
            log_info "  Added binding: $agent_name"
        fi
    done
    if [[ "$bindings_added" -eq 0 ]]; then
        log_ok "All bindings already exist (no changes)"
    else
        log_ok "Added $bindings_added new binding(s)"
    fi

    # Clean stale env vars from plist (macOS only)
    if [[ "$(uname)" == "Darwin" ]]; then
        if clean_plist_env; then
            cmd_restart_quiet
        else
            cmd_reload
        fi
    else
        cmd_restart_quiet
    fi

    cmd_verify
}

# Clean install — only use when the extension is genuinely broken
cmd_clean() {
    check_deps
    check_env_file
    check_config

    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  ax-clawdbot Clean Install${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    # Back up config before any changes
    backup_config

    if [[ -d "$EXTENSION_DIR" ]]; then
        log_info "Removing old extension at $EXTENSION_DIR"
        rm -rf "$EXTENSION_DIR"
    fi

    # Remove installs entry (but preserve plugin entries config)
    log_info "Clearing install manifest..."
    UPDATED_CONFIG=$(jq 'del(.plugins.installs["ax-platform"])' "$CONFIG_FILE")
    echo "$UPDATED_CONFIG" > "$CONFIG_FILE"

    log_info "Reinstalling plugin..."
    cd "$SCRIPT_DIR/extension"
    if $CLI_CMD plugins install . 2>&1 | head -5; then
        log_ok "Plugin installed"
    else
        # Fallback: manual copy if CLI install fails
        log_warn "CLI install failed, copying manually..."
        mkdir -p "$EXTENSION_DIR"
        cp -r "$SCRIPT_DIR/extension/"* "$EXTENSION_DIR/"
        UPDATED_CONFIG=$(jq --arg src "$SCRIPT_DIR/extension" --arg dst "$EXTENSION_DIR" '
            .plugins.installs["ax-platform"] = {
                source: "path",
                sourcePath: $src,
                installPath: $dst,
                version: "0.2.0",
                installedAt: (now | strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            }
        ' "$CONFIG_FILE")
        echo "$UPDATED_CONFIG" > "$CONFIG_FILE"
        log_ok "Extension installed (manual copy)"
    fi
    cd "$SCRIPT_DIR"

    echo ""

    # Now sync credentials (safe — won't overwrite other config)
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

# Clean up stale AX_* env vars from LaunchAgent plist (macOS only)
clean_plist_env() {
    local plist_file="$HOME/Library/LaunchAgents/${LAUNCH_AGENT}.plist"

    if [[ ! -f "$plist_file" ]]; then
        return 0
    fi

    if grep -q "AX_AGENTS\|AX_AGENT_ID\|AX_WEBHOOK_SECRET" "$plist_file" 2>/dev/null; then
        log_info "Removing stale AX_* env vars from LaunchAgent plist..."
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_AGENTS" "$plist_file" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_AGENT_ID" "$plist_file" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:AX_WEBHOOK_SECRET" "$plist_file" 2>/dev/null || true
        log_ok "Cleaned plist env vars"
        return 1  # Signal plist was modified
    fi

    return 0
}

# Find and signal the running gateway process
# Works on both macOS (launchctl) and Linux (systemd or direct process)
gateway_restart() {
    if [[ "$(uname)" == "Darwin" ]]; then
        launchctl stop $LAUNCH_AGENT 2>/dev/null || true
        sleep 2
        launchctl start $LAUNCH_AGENT
        sleep 3
        return 0
    fi

    # Linux: try systemctl first, then direct process signal
    if systemctl --user restart openclaw-gateway.service 2>/dev/null; then
        sleep 3
        return 0
    fi

    if sudo systemctl restart openclaw-gateway.service 2>/dev/null; then
        sleep 3
        return 0
    fi

    # Fallback: signal the running process directly
    local gw_pid
    gw_pid=$(pgrep -x openclaw-gateway 2>/dev/null | head -1)
    if [[ -n "$gw_pid" ]]; then
        log_info "Sending SIGHUP to gateway (PID $gw_pid)..."
        kill -HUP "$gw_pid" 2>/dev/null || true
        sleep 3
        # Check if it's still running (SIGHUP may trigger config reload)
        if kill -0 "$gw_pid" 2>/dev/null; then
            log_ok "Gateway signaled (PID $gw_pid)"
            return 0
        fi
    fi

    # Last resort: kill and restart
    if [[ -n "$gw_pid" ]]; then
        log_info "Stopping gateway (PID $gw_pid)..."
        kill "$gw_pid" 2>/dev/null || true
        sleep 2
    fi

    # Try to start via CLI (openclaw gateway --port ...)
    log_info "Starting gateway..."
    local cli_path
    cli_path=$(command -v "$CLI_CMD" 2>/dev/null || echo "")
    if [[ -n "$cli_path" ]]; then
        local port="${OPENCLAW_GATEWAY_PORT:-18789}"
        nohup "$cli_path" gateway --port "$port" > "$CONFIG_DIR/gateway-restart.log" 2>&1 &
        sleep 4
        if pgrep -f "$CLI_CMD.*gateway" > /dev/null 2>&1; then
            local new_pid
            new_pid=$(pgrep -f "$CLI_CMD.*gateway" | head -1)
            log_ok "Gateway started (PID $new_pid)"
            return 0
        fi
    fi

    log_warn "Could not restart gateway automatically."
    log_warn "Please restart manually: $CLI_CMD gateway --port 18789 &"
    return 1
}

cmd_restart() {
    log_info "Restarting gateway..."
    gateway_restart
    cmd_verify
}

# Full reload (macOS only — unload/load plist)
cmd_reload() {
    log_info "Reloading gateway..."
    if [[ "$(uname)" == "Darwin" ]]; then
        launchctl unload ~/Library/LaunchAgents/${LAUNCH_AGENT}.plist 2>/dev/null || true
        sleep 2
        launchctl load ~/Library/LaunchAgents/${LAUNCH_AGENT}.plist 2>/dev/null || true
        sleep 3
        log_ok "Gateway reloaded"
    else
        gateway_restart
    fi
}

cmd_restart_quiet() {
    log_info "Restarting gateway..."
    gateway_restart
}

# Verify registration
cmd_verify() {
    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  Verification${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    # Check multiple log locations
    local log_file=""
    for candidate in "$CONFIG_DIR/logs/gateway.log" "$CONFIG_DIR/gateway-restart.log"; do
        if [[ -f "$candidate" ]]; then
            log_file="$candidate"
            break
        fi
    done

    if [[ -n "$log_file" ]] && tail -30 "$log_file" 2>/dev/null | grep -q "ax-platform.*Registered agents\|ax-platform.*Plugin loaded"; then
        tail -30 "$log_file" | grep "ax-platform" | grep -E "Registered|@|Plugin loaded" | tail -5
        echo ""
        log_ok "Setup complete!"
    elif pgrep -x openclaw-gateway > /dev/null 2>&1; then
        local gw_pid=$(pgrep -x openclaw-gateway | head -1)
        log_ok "Gateway running (PID $gw_pid)"
        log_info "Check logs: tail -f $CONFIG_DIR/gateway-restart.log | grep ax-platform"
    else
        log_warn "Could not verify registration. Check logs:"
        echo "  tail -f $CONFIG_DIR/gateway-restart.log | grep ax-platform"
    fi
    echo ""
}

# Tail logs
cmd_logs() {
    log_info "Tailing gateway logs (Ctrl+C to exit)..."
    echo ""
    # Try multiple log locations
    for candidate in "$CONFIG_DIR/logs/gateway.log" "$CONFIG_DIR/gateway-restart.log"; do
        if [[ -f "$candidate" ]]; then
            tail -f "$candidate" | grep --line-buffered "ax-platform"
            return
        fi
    done
    log_error "No log file found"
}

# Check status
cmd_status() {
    echo ""
    echo -e "${CYAN}===========================================${NC}"
    echo -e "${CYAN}  Status${NC}"
    echo -e "${CYAN}===========================================${NC}"
    echo ""

    # Gateway
    local gw_pid
    gw_pid=$(pgrep -x openclaw-gateway 2>/dev/null | head -1)
    if [[ -n "$gw_pid" ]]; then
        local uptime
        uptime=$(ps -o etime= -p "$gw_pid" 2>/dev/null | tr -d ' ')
        log_ok "Gateway: Running (PID $gw_pid, uptime $uptime)"
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
        log_info "Agents in env file: $count"
    fi

    # Agents in config file
    if [[ -f "$CONFIG_FILE" ]]; then
        local config_count=$(jq '.plugins.entries["ax-platform"].config.agents | length' "$CONFIG_FILE" 2>/dev/null || echo 0)
        log_info "Agents in config: $config_count"
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
