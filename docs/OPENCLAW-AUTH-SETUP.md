# OpenClaw + Claude Max: Authentication Setup

## Setup (2 minutes)

### 1. Get your token

On any machine where you're logged into Claude Max:

```bash
claude setup-token
```

Copy the `sk-ant-oat01-...` token it gives you.

### 2. Set the environment variable

Add it to the gateway's systemd unit:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d/
cat > ~/.config/systemd/user/openclaw-gateway.service.d/anthropic.conf << 'EOF'
[Service]
Environment=ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-YOUR_TOKEN_HERE
EOF
```

### 3. Restart

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

That's it. All agents on the gateway will use this token.

## Why an env var?

If multiple agents each cache their own copy of the token (in `auth-profiles.json`), Anthropic's token rotation can cause one agent's refresh to invalidate everyone else's copy. A single shared env var avoids this entirely.

## API key alternative

If you have an Anthropic API account (separate billing from Max):

```bash
Environment=ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE
```

API keys don't rotate, but they bill per-token instead of using your Max subscription.
