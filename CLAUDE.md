# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Quick Reference

```bash
# After any code or config changes
./setup.sh sync

# Watch logs
./setup.sh logs

# Check status
./setup.sh status
```

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

```
aX Backend → Cloudflare Tunnel → Gateway (host) → Clawdbot Sandbox → Response
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

Quick tunnels are ephemeral - URL changes on restart:

```bash
# Start tunnel
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
