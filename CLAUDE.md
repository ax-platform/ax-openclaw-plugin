# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local Documentation

Reference docs are in `docs/` (gitignored). Check there for:
- Clawdbot plugin SDK documentation
- aX Platform API reference
- Webhook payload examples

External references:
- [Clawdbot](https://clawdbot.com)
- [aX Platform](https://paxai.app)
- [aX Registration](https://paxai.app/register)

## Project Overview

**ax-clawdbot** is a Clawdbot plugin that bridges locally-running Claude agents to the aX Platform cloud collaboration system. Users run their AI agent locally while participating in aX workspaces, receiving @mentions and collaborating with other agents.

## Development Commands

```bash
# Install the extension locally
cd extension && clawdbot plugins install .

# Restart gateway after changes (runs on host via launchctl)
launchctl stop com.clawdbot.gateway && launchctl start com.clawdbot.gateway

# Watch logs during development
tail -f ~/.clawdbot/logs/gateway.log | grep ax-platform

# Test webhook dispatch locally
curl -X POST http://localhost:18789/ax/dispatch \
  -H "Content-Type: application/json" \
  -d '{"dispatch_id":"test","agent_id":"123","agent_handle":"test-agent","user_message":"hello"}'
```

## Docker Environment

The extension runs in a hybrid Docker setup:

| Component | Location | Notes |
|-----------|----------|-------|
| Gateway | Host (launchctl) | Receives webhooks, spawns sandboxes |
| Backend API | `ax-backend-api:8001` | Docker container |
| Agent sandboxes | `clawdbot-sbx-ax-agent-{id}` | Per-agent Docker containers |

```bash
# Check running containers
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "(agent|clawdbot|backend)"

# Check backend logs
docker logs ax-backend-api --tail 50

# Check agent sandbox logs
docker logs clawdbot-sbx-ax-agent-{agent_id_prefix} --tail 50

# Gateway logs (on host)
tail -50 ~/.clawdbot/logs/gateway.log
tail -20 ~/.clawdbot/logs/gateway.err.log
```

## Architecture

### Request Flow

1. aX backend POSTs to `/ax/dispatch` with dispatch payload
2. HMAC signature verified (X-AX-Signature + X-AX-Timestamp headers, 5-min replay window)
3. Message passed to local Clawdbot via CLI with session routing by `agent_id`
4. Progress updates POSTed to backend during processing (fire-and-forget)
5. Response extracted from clawdbot JSON output and returned to backend
6. Backend posts response back to conversation

### Key Files

- `extension/index.ts` - Core plugin: HTTP handlers, HMAC verification, MCP client, dispatch processing
- `extension/plugin.json` - Plugin manifest with config schema
- `install.sh` - One-liner installer script

### HTTP Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/ax/dispatch` | GET | WebSub verification (hub.challenge echo) |
| `/ax/dispatch` | POST | Main webhook for receiving/processing messages |
| `/ax/register` | POST | Self-registration with aX backend |

### Session Routing

Sessions are routed by `agent_id` (not space/sender), allowing persistent memory across all conversations:
```
Session ID: ax-agent-{agent_id}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AX_AGENTS` | Multi-agent config JSON: `[{"id":"...","secret":"...","handle":"@name","env":"prod"}]` |
| `AX_WEBHOOK_SECRET` | HMAC secret (single-agent fallback) |
| `AX_AGENT_ID` | Agent ID (single-agent fallback) |
| `AX_AUTH_TOKEN` | Bearer token for MCP tool calls (set from dispatch) |
| `AX_MCP_ENDPOINT` | aX MCP server endpoint (set from dispatch) |
| `AX_BACKEND_URL` | Backend API for progress updates (default: localhost:8001) |
| `CLAWDBOT_CMD` | Path to clawdbot binary |

### Multi-Agent Config Format

```json
[
  {"id": "uuid", "secret": "...", "handle": "@clawdbot", "env": "prod", "url": "https://..."},
  {"id": "uuid", "secret": "...", "handle": "@clawdbot-dev", "env": "local"}
]
```

On startup, logs show: `[ax-platform] @clawdbot [prod] → e5c6041a...`

### Multi-text Response Handling

Clawdbot CLI can output invalid JSON with duplicate `"text"` keys. The extension uses regex extraction to capture ALL text values before falling back to standard JSON parsing:
```typescript
const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
```

## Design Principles

- **Input/Output Pattern**: Dispatch receives message → processes → returns response. Backend handles posting.
- **MCP as Auxiliary Tools**: Agent uses MCP for reading context only (spaces, tasks, search), not for posting responses.
- **Fire-and-forget Progress**: Progress updates don't block dispatch on failures.
- **"Agents think; Infrastructure acts"**: Agent focuses on processing, backend handles messaging.
