# OpenClaw + Claude Max: Authentication Setup (EC2)

How to authenticate OpenClaw agents with your Claude Max subscription on EC2.

## The Problem

OpenClaw agents each maintain their own `auth-profiles.json` with a copy of the
Anthropic OAuth token. Anthropic uses **token rotation** — each refresh issues a
new token and invalidates the old one. When one agent refreshes, the others' copies
go stale and all agents start failing with:

```
OAuth token refresh failed for anthropic: Failed to refresh OAuth token
```

## The Solution: `claude setup-token` + Shared Env Var

Instead of per-agent token copies, use a single **long-lived OAuth token** from
`claude setup-token`, set as an environment variable that all agents read.

### Step 1: Generate a Stable Token

On any machine where you're logged into Claude:

```bash
claude setup-token
```

This produces a long-lived `sk-ant-oat01-...` token tied to your Max subscription.
Copy the token value.

### Step 2: Set the Environment Variable

On the EC2 instance, update two files:

**A. Systemd drop-in** (used by the gateway service):

```bash
# Create/update the drop-in
cat > ~/.config/systemd/user/openclaw-gateway.service.d/anthropic.conf << 'EOF'
[Service]
Environment=ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-YOUR_TOKEN_HERE
EOF
```

**B. `.openclaw-env`** (backup, used by legacy systemd unit):

```bash
echo 'ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-YOUR_TOKEN_HERE' > ~/.openclaw-env
```

**C. Shell profile** (for manual CLI usage):

```bash
echo 'export ANTHROPIC_OAUTH_TOKEN="sk-ant-oat01-YOUR_TOKEN_HERE"' >> ~/.bash_profile
echo 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-YOUR_TOKEN_HERE"' >> ~/.bash_profile
```

### Step 3: Clear Stale Per-Agent Profiles

Remove the cached `anthropic:claude-code` entries so agents fall through to the env var:

```bash
for agent in main clawdbot_cipher logic_runner_677 nova_sage react_ranger; do
  file="$HOME/.openclaw/agents/$agent/agent/auth-profiles.json"
  if [ -f "$file" ]; then
    python3 -c "
import json
with open('$file') as f:
    d = json.load(f)
d.get('profiles', {}).pop('anthropic:claude-code', None)
d.get('lastGood', {}).pop('anthropic', None)
d.get('usageStats', {}).pop('anthropic:claude-code', None)
with open('$file', 'w') as f:
    json.dump(d, f, indent=2)
"
    echo "Cleared: $agent"
  fi
done
```

### Step 4: Restart the Gateway

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

### Step 5: Verify

```bash
# Check gateway is running
systemctl --user status openclaw-gateway.service

# Confirm token is in process env
cat /proc/$(pgrep -f openclaw-gateway)/environ | tr '\0' '\n' | grep ANTHROPIC_OAUTH

# Test an agent (from aX or CLI)
# @agent_name ping
```

## How It Works

OpenClaw resolves Anthropic credentials in this order:

1. Per-agent `auth-profiles.json` (`~/.openclaw/agents/<name>/agent/auth-profiles.json`)
2. Environment variable `ANTHROPIC_OAUTH_TOKEN`
3. Environment variable `ANTHROPIC_API_KEY`

By clearing #1, all agents fall through to #2 (the shared env var).

## Key Files

| File | Purpose |
|------|---------|
| `~/.config/systemd/user/openclaw-gateway.service.d/anthropic.conf` | Systemd drop-in with `ANTHROPIC_OAUTH_TOKEN` |
| `~/.openclaw-env` | EnvironmentFile loaded by legacy systemd unit |
| `~/.openclaw/agents/<name>/agent/auth-profiles.json` | Per-agent auth (should NOT have anthropic entry) |
| `~/fetch-claude-token.sh` | Legacy token refresh script (runs every 6h via timer) |
| `~/.claude/.credentials.json` | Claude Code's own OAuth credentials |

## Token Lifetime

- Tokens from `claude setup-token` are long-lived but do eventually expire
- If agents start failing again, re-run `claude setup-token` and update the
  drop-in + `.openclaw-env` with the new value, then restart the gateway

## API Key Alternative

If you have an Anthropic API account (separate billing from Max), you can use
an API key instead of an OAuth token:

```bash
# In the systemd drop-in:
Environment=ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE
```

API keys don't expire or rotate, making them more stable. But they use
per-token billing rather than your Max subscription.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "OAuth token refresh failed for anthropic" | Stale token in auth-profiles.json | Clear profiles (Step 3), restart gateway |
| All agents fail simultaneously | Shared token expired | Re-run `claude setup-token`, update drop-in |
| One agent works, others don't | Agent re-cached a token in auth-profiles.json | Clear that agent's auth-profiles.json |
| Gateway starts but agents can't call Claude | Env var not in process | Check drop-in loaded: `systemctl --user status openclaw-gateway` should show `anthropic.conf` |
