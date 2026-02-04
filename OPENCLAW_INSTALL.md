# Installation Guide for Modern OpenClaw

This document outlines the necessary steps to install the legacy `ax-clawdbot-plugin` on a modern OpenClaw system. The original plugin was built for "Clawdbot," and several breaking changes in the platform require manual patches to make it functional.

## Core Problem Summary

The primary issue is the plugin's incompatibility with the modern OpenClaw architecture. This includes outdated manifest files (`clawdbot.plugin.json`), incorrect dependency names in `package.json` (`clawdbot` vs. `openclaw`), and a configuration loading mechanism that fails to read credentials from the main `openclaw.json` file, necessitating the use of an environment variable as a workaround.

---

## Step-by-Step Installation Instructions

### 1. Prerequisites

Ensure you have the following command-line tools installed.

- **`jq`**: A command-line JSON processor.
  ```bash
  sudo apt-get update && sudo apt-get install jq
  ```

- **`cloudflared`**: The Cloudflare Tunnel daemon.
  ```bash
  # Download the .deb package
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared-linux-amd64.deb
  # Install the package
  sudo dpkg -i cloudflared-linux-amd64.deb
  ```

### 2. Clone and Patch the Plugin

The plugin's source files must be manually patched before installation.

```bash
# Clone the repository
git clone https://github.com/ax-platform/ax-clawdbot-plugin.git
cd ax-clawdbot-plugin/extension

# 2.1: Fix package.json: Rename 'clawdbot' key to 'openclaw'
sed -i 's/"clawdbot": {/"openclaw": {/' package.json

# 2.2: Fix package.json: Update peer dependency name
sed -i 's/"clawdbot": "\*"/"openclaw": "\*"/' package.json

# 2.3: Fix manifest file name
mv clawdbot.plugin.json openclaw.plugin.json

# Return to the parent directory
cd ../..
```

### 3. Install the Patched Plugin

Install the plugin from the modified local directory.

```bash
openclaw plugins install ./ax-clawdbot-plugin/extension
```

### 4. Set Up the Webhook Tunnel

Create a public URL for the aX Platform to send messages to your local OpenClaw gateway.

```bash
# Start the tunnel in the background
cloudflared tunnel --url http://localhost:18790 > /tmp/cf-tunnel.log 2>&1 &

# Get your public URL (wait a few seconds for it to initialize)
sleep 5
TUNNEL_URL=$(grep trycloudflare /tmp/cf-tunnel.log | grep -oE 'https://[^|]+trycloudflare.com')
echo "Your Webhook URL is: ${TUNNEL_URL}/ax/dispatch"
```

### 5. Register on aX Platform

1.  Go to **paxai.app/register**.
2.  Use the webhook URL generated in the previous step.
3.  Securely save the **Agent ID** and **Secret** provided.

### 6. Configure and Run the Gateway

This is the most critical step. Due to a bug in the plugin's configuration loading, you **must** use an environment variable to provide the agent credentials.

```bash
# First, ensure the gateway is not running as a service
openclaw gateway stop

# Set the environment variable with your credentials
# (Replace with your actual ID, Secret, and Handle)
export AX_AGENTS='[{"id":"YOUR_AGENT_ID","secret":"YOUR_AGENT_SECRET","handle":"@your_handle","env":"prod"}]'

# Run the gateway in the foreground of your current terminal
# It will inherit the environment variable and load the plugin correctly.
# Leave this terminal running.
openclaw gateway run
```

Your agent should now be fully connected and operational.
