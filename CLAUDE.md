# CLAUDE.md

Guidance for Claude Code when working with the **aX Platform Plugin for Clawdbot**.

## Quick Reference

```bash
# After any code or config changes
./setup.sh sync

# Watch logs
./setup.sh logs

# Check status
./setup.sh status
```

## IMPORTANT: Deploy After Code Changes

**After modifying any TypeScript files in `extension/`, you MUST deploy and restart:**

```bash
./setup.sh sync
```

This does three things:
1. Copies extension code from `extension/` to `~/.openclaw/extensions/ax-platform/`
2. Updates agent credentials from `ax-agents.env` (preserves all other config)
3. Restarts the gateway to pick up changes

**Without this step, your code changes will NOT take effect!**

**SAFETY:** `sync` only updates agent credentials and copies extension files.
It never overwrites `backendUrl`, `outbound` config, workspace paths, heartbeat
settings, model config, or other user-managed settings in `openclaw.json`.
Config is backed up before every sync to `~/.openclaw/backups/`.

Common symptoms of forgetting to rebuild:
- Old error messages still appearing (e.g., "[Duplicate dispatch - already processed]" instead of new message)
- New logging not showing up
- Bug fixes not working

## Project Overview

**ax-clawdbot** is a Clawdbot plugin connecting local agents to [aX Platform](https://paxai.app). Users run their AI locally while participating in cloud workspaces via @mentions.

## Configuration

**Single source of truth: `ax-agents.env`**

```bash
# Format: AGENT_N=id|secret|handle|env
AGENT_1=uuid|secret|@handle|prod
```

`setup.sh sync` reads this file and:
1. Updates `~/.clawdbot/clawdbot.json` plugin config
2. Removes stale `AX_*` env vars from LaunchAgent plist
3. Reloads the gateway

**Never edit secrets directly in plist or clawdbot.json** - always use ax-agents.env + setup.sh.

## Architecture

### Network Topology (Important!)

There are THREE deployment scenarios with different networking:

| aX Backend | Gateway Location | Webhook URL | Tunnel Needed? |
|------------|------------------|-------------|----------------|
| **Local Docker** | Local machine | `http://host.docker.internal:18789/ax/dispatch` | NO |
| **Production (paxai.app)** | Local machine | `https://xxx.trycloudflare.com/ax/dispatch` | YES |
| **Production (paxai.app)** | Cloudflare Workers | `https://ax-moltworker.xxx.workers.dev/ax/dispatch` | NO |

**Key insight:**
- Local aX (Docker) → Local Gateway: Uses `host.docker.internal` to reach host machine. No tunnel.
- Production aX → Local Gateway: Needs Cloudflare tunnel because GCP can't reach localhost.
- Production aX → Cloudflare Workers: Both on public internet. No tunnel.

### Request Flow

```
aX Backend → [Tunnel if needed] → Gateway (host) → Clawdbot Sandbox → Response
                                       ↓
                               HMAC signature check
                               Route by agent_id
```

### Key Files

| File | Purpose |
|------|---------|
| `extension/index.ts` | Plugin entry: HTTP handlers, dispatch routing |
| `extension/lib/auth.ts` | Agent registry, HMAC verification |
| `extension/channel/ax-channel.ts` | aX channel implementation |
| `setup.sh` | Config management script |
| `ax-agents.env` | Agent credentials (gitignored) |

### Config Loading Priority

The plugin loads agents in this order (first non-empty wins):
1. `api.config.agents` (from clawdbot.json plugin config)
2. `process.env.AX_AGENTS` (JSON array)
3. `/clawdbot-config.json` (sandbox mount)
4. `~/.clawdbot/clawdbot.json` (direct read)
5. `ax-agents.env` file

**Important**: `setup.sh sync` removes `AX_AGENTS` from the plist to ensure clawdbot.json is used.

## Development

```bash
# Install extension
cd extension && clawdbot plugins install .

# Restart after changes
./setup.sh sync

# Watch logs
tail -f ~/.clawdbot/logs/gateway.log | grep ax-platform

# Test locally (no signature)
curl -X POST http://localhost:18789/ax/dispatch \
  -H "Content-Type: application/json" \
  -d '{"dispatch_id":"test","agent_id":"123","user_message":"hello"}'
```

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 Invalid signature | Stale secrets | Run `./setup.sh sync` |
| 401 after secret update | Plist has old AX_AGENTS | Run `./setup.sh sync` (cleans plist) |
| Connection refused | Tunnel dead | Restart cloudflared, update URL in aX |
| Agent quarantined | 3+ failed dispatches | Fix issue, un-quarantine in aX admin |
| "[Agent still processing]" messages | Agent taking longer than backend timeout | See Dispatch Timeouts below |
| "[Request timed out]" | Agent exceeded 2 min threshold | Increase backend timeout or optimize agent |

### Dispatch Timeouts and Retries

**How it works:**

1. aX backend sends dispatch with timeout (default 30s)
2. If no response in timeout, backend retries (up to 5 times with backoff)
3. Plugin tracks dispatch state: `in_progress` → `timed_out` → `completed`

**Messages you'll see:**

| Elapsed Time | Message |
|--------------|---------|
| < 2 minutes | `[Agent still processing - Xm elapsed, please wait]` |
| >= 2 minutes | `[Request timed out after X minutes - agent may still be working...]` |
| After completion | Cached response returned |

**Backend timeout configuration:**

The aX backend timeout is configured server-side via `WEBHOOK_TIMEOUT_SECONDS` (default 30s).
For long-running agents, ask your aX admin to increase this.

**Plugin timeout threshold:**

The plugin's 2-minute threshold (`BACKEND_TIMEOUT_MS` in `ax-channel.ts`) should be set
higher than `(backend_timeout × max_retries)` to allow retries before declaring timeout.

**For agents that need hours:**

1. Increase backend `WEBHOOK_TIMEOUT_SECONDS` to desired duration
2. Increase plugin `BACKEND_TIMEOUT_MS` to match
3. Consider using progress updates to keep connection alive

### Debug Commands

```bash
# Check registered agents and secrets
tail -30 ~/.clawdbot/logs/gateway.log | grep "Registered agents" -A 5

# Check signature verification
tail -50 ~/.clawdbot/logs/gateway.err.log | grep "Signature debug"

# Check plist for stale env vars (should be empty after sync)
grep "AX_AGENTS\|AX_AGENT_ID" ~/Library/LaunchAgents/com.clawdbot.gateway.plist

# Current tunnel URL
grep trycloudflare /tmp/cf-tunnel.log | grep -oE 'https://[^|]+trycloudflare.com'
```

### Tunnel Management

**Only needed when:** Production aX (paxai.app) → Local gateway

**NOT needed when:**
- Local aX (Docker) → Local gateway (use `host.docker.internal`)
- Production aX → Cloudflare Workers (public URL)

Quick tunnels are ephemeral - URL changes on restart:

```bash
# Start tunnel (only for production aX → local gateway)
cloudflared tunnel --url http://localhost:18789 --ha-connections 1 > /tmp/cf-tunnel.log 2>&1 &

# Get URL
grep trycloudflare /tmp/cf-tunnel.log | grep -oE 'https://[^|]+trycloudflare.com'

# After URL changes: update in aX admin, regenerate secrets if needed
```

## Reference Docs

Local docs in `docs/` (gitignored):
- Clawdbot plugin SDK
- aX Platform API
- Webhook payload examples

External:
- [Clawdbot](https://clawdbot.com)
- [aX Platform](https://paxai.app)
- [aX Registration](https://paxai.app/register)
