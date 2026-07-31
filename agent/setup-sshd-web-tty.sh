#!/bin/bash
set -e

WORKER_URL="${1:-https://gh-codespace-telegram-bot.mm-adnanakib.workers.dev}"
AGENT_SECRET="${2:-super_secret_agent_key_123}"
TARGET_CHAT_ID="${3:-$CHAT_ID}"
CODESPACE_NAME="${CODESPACE_NAME:-$HOSTNAME}"

if [ "$TARGET_CHAT_ID" = "YOUR_CHAT_ID" ]; then
  TARGET_CHAT_ID=""
fi

echo "============================================================"
echo "🚀 Setting up OpenSSH Server, ttyd & Auto-Boot Tunnel..."
echo "Codespace: $CODESPACE_NAME"
echo "Worker URL: $WORKER_URL"
echo "============================================================"

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

echo "📦 Checking SSHD status..."
if command -v sshd >/dev/null 2>&1; then
  echo "✅ OpenSSH Server is available."
  $SUDO service ssh status >/dev/null 2>&1 || $SUDO service ssh start || true
fi

AGENT_DIR="$HOME/.codespace-telegram-agent"
mkdir -p "$AGENT_DIR"
rm -f "$AGENT_DIR"/*.log

# Auto-configure .devcontainer/devcontainer.json for public port 7681 auto-forwarding
WORKSPACE_DIR="$(pwd)"
if [ -d "/workspaces" ]; then
  FIRST_WS=$(ls -d /workspaces/* 2>/dev/null | head -n 1 || true)
  if [ -n "$FIRST_WS" ] && [ -d "$FIRST_WS" ]; then
    WORKSPACE_DIR="$FIRST_WS"
  fi
fi

if [ -d "$WORKSPACE_DIR" ]; then
  DEVCONTAINER_DIR="$WORKSPACE_DIR/.devcontainer"
  if [ ! -f "$DEVCONTAINER_DIR/devcontainer.json" ]; then
    mkdir -p "$DEVCONTAINER_DIR"
    cat << EOF > "$DEVCONTAINER_DIR/devcontainer.json"
{
  "name": "Codespace Telegram Agent & Web Terminal",
  "forwardPorts": [7681],
  "portsAttributes": {
    "7681": {
      "label": "ttyd Web Terminal",
      "onAutoForward": "ignore",
      "visibility": "public"
    }
  },
  "postStartCommand": "test -f ~/.codespace-telegram-agent/start.sh && ~/.codespace-telegram-agent/start.sh || curl -sSL '${WORKER_URL}/agent/setup-sshd-web-tty.sh?chat_id=${TARGET_CHAT_ID}' | bash"
}
EOF
    echo "✅ Auto-configured .devcontainer/devcontainer.json for public port 7681 forwarding"
  fi
fi

echo "📦 Installing / Checking ttyd web terminal binary..."
if ! command -v ttyd >/dev/null 2>&1 && [ ! -f "$AGENT_DIR/ttyd" ]; then
  echo "📥 Downloading ttyd binary..."
  curl -sSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" -o "$AGENT_DIR/ttyd"
  chmod +x "$AGENT_DIR/ttyd"
  TTYD_BIN="$AGENT_DIR/ttyd"
else
  if command -v ttyd >/dev/null 2>&1; then
    TTYD_BIN="ttyd"
  else
    TTYD_BIN="$AGENT_DIR/ttyd"
  fi
fi

echo "🖥️ Starting ttyd server on 0.0.0.0:7681..."
pkill -f "ttyd" || true
eval "nohup $TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > $AGENT_DIR/ttyd.log 2>&1 &"

sleep 2

PUBLIC_TTYD_URL=""
if command -v gh >/dev/null 2>&1; then
  echo "🌐 Setting up GitHub Codespaces Native Public Port 7681..."
  gh codespace ports forward 7681:7681 -c "$CODESPACE_NAME" 2>/dev/null || true
  gh codespace ports visibility 7681:public -c "$CODESPACE_NAME" 2>/dev/null || true
  GH_APP_URL="https://${CODESPACE_NAME}-7681.app.github.dev"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$GH_APP_URL" || true)
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "401" ]; then
    PUBLIC_TTYD_URL="$GH_APP_URL"
    echo "✅ GitHub Native Tunnel active: ${PUBLIC_TTYD_URL}"
  fi
fi

echo "🌐 Launching Zero-Login Public Tunnels for ttyd (Cloudflare, Serveo & Pinggy)..."
pkill -f "cloudflared" || true
pkill -f "ssh.*serveo" || true
pkill -f "ssh.*pinggy" || true

if ! command -v cloudflared >/dev/null 2>&1 && [ ! -f "$AGENT_DIR/cloudflared" ]; then
  echo "📥 Downloading cloudflared binary for fast HTTPS tunnel..."
  curl -sSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o "$AGENT_DIR/cloudflared" 2>/dev/null || true
  chmod +x "$AGENT_DIR/cloudflared" 2>/dev/null || true
fi

CF_BIN=""
if command -v cloudflared >/dev/null 2>&1; then
  CF_BIN="cloudflared"
elif [ -f "$AGENT_DIR/cloudflared" ]; then
  CF_BIN="$AGENT_DIR/cloudflared"
fi

if [ -n "$CF_BIN" ]; then
  eval "nohup $CF_BIN tunnel --url http://localhost:7681 > $AGENT_DIR/cloudflared.log 2>&1 &"
fi

eval "nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:7681 serveo.net > $AGENT_DIR/serveo.log 2>&1 &"
eval "nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > $AGENT_DIR/pinggy.log 2>&1 &"

if [ -z "$PUBLIC_TTYD_URL" ]; then
  for i in {1..20}; do
    CANDIDATE=""
    if [ -f "$AGENT_DIR/cloudflared.log" ]; then
      CANDIDATE=$(grep -a -oE "https://[a-zA-Z0-9.-]+\.trycloudflare\.com" "$AGENT_DIR/cloudflared.log" | tail -n 1 || true)
    fi
    if [ -z "$CANDIDATE" ] && [ -f "$AGENT_DIR/serveo.log" ]; then
      CANDIDATE=$(grep -a -oE "https://[a-zA-Z0-9.-]+\.serveo\.net" "$AGENT_DIR/serveo.log" | tail -n 1 || true)
    fi
    if [ -z "$CANDIDATE" ] && [ -f "$AGENT_DIR/pinggy.log" ]; then
      CANDIDATE=$(grep -a -oE "https://[a-zA-Z0-9.-]+\.(pinggy\.online|pinggy\.link)" "$AGENT_DIR/pinggy.log" | tail -n 1 || true)
    fi

    if [[ "$CANDIDATE" == https://* ]]; then
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "$CANDIDATE" || true)
      if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "401" ]; then
        PUBLIC_TTYD_URL="$CANDIDATE"
        break
      fi
    fi
    sleep 1
  done
fi

echo ""
echo "============================================================"
if [ -n "$PUBLIC_TTYD_URL" ]; then
  echo "🌐 Live ttyd Web Terminal URL: ${PUBLIC_TTYD_URL}"
else
  echo "🖥️ ttyd server running on local port 7681 (Background agent will register tunnel URL when live)"
fi
echo "============================================================"
echo ""

echo "📥 Fetching Background Telegram Agent..."
curl -sSL "${WORKER_URL}/agent/agent.js" -o "$AGENT_DIR/agent.js"

START_SCRIPT="$AGENT_DIR/start.sh"
cat << EOF > "$START_SCRIPT"
#!/bin/bash
export HOME="${HOME:-/root}"
AGENT_DIR="\$HOME/.codespace-telegram-agent"

if pgrep -f 'node.*agent.js' > /dev/null 2>&1; then
  exit 0
fi

TTYD_BIN="ttyd"
if [ -f "\$AGENT_DIR/ttyd" ]; then
  TTYD_BIN="\$AGENT_DIR/ttyd"
fi

pgrep -f "ttyd" > /dev/null 2>&1 || nohup \$TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > "\$AGENT_DIR/ttyd.log" 2>&1 &
[ -f "\$AGENT_DIR/cloudflared" ] && ! pgrep -f "cloudflared" >/dev/null 2>&1 && nohup "\$AGENT_DIR/cloudflared" tunnel --url http://localhost:7681 > "\$AGENT_DIR/cloudflared.log" 2>&1 &
pgrep -f "ssh.*pinggy" > /dev/null 2>&1 || nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > "\$AGENT_DIR/pinggy.log" 2>&1 &

if [ -f "\$AGENT_DIR/agent.js" ]; then
  nohup node "\$AGENT_DIR/agent.js" "${WORKER_URL}" "${AGENT_SECRET}" "${CODESPACE_NAME}" "${PUBLIC_TTYD_URL}" "${TARGET_CHAT_ID}" > "\$AGENT_DIR/agent.log" 2>&1 &
fi
EOF
chmod +x "$START_SCRIPT"

# 1. ~/.bashrc
if ! grep -q "codespace-telegram-agent/start.sh" ~/.bashrc 2>/dev/null; then
  echo "" >> ~/.bashrc
  echo "test -f \"$START_SCRIPT\" && \"$START_SCRIPT\" >/dev/null 2>&1 &" >> ~/.bashrc
  echo "✅ Configured auto-start in ~/.bashrc"
fi

# 2. ~/.zshrc
if [ -f ~/.zshrc ] && ! grep -q "codespace-telegram-agent/start.sh" ~/.zshrc 2>/dev/null; then
  echo "" >> ~/.zshrc
  echo "test -f \"$START_SCRIPT\" && \"$START_SCRIPT\" >/dev/null 2>&1 &" >> ~/.zshrc
  echo "✅ Configured auto-start in ~/.zshrc"
fi

# 3. Crontab @reboot (For Headless Container Boot)
if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "codespace-telegram-agent" || true; echo "@reboot $START_SCRIPT >/dev/null 2>&1 &") | crontab - 2>/dev/null || true
  echo "✅ Configured crontab @reboot auto-start for background boots"
fi

# 4. System-wide /etc/profile.d/
if [ -d /etc/profile.d ]; then
  if [ -n "$SUDO" ]; then
    $SUDO bash -c "echo 'test -f \"$START_SCRIPT\" && \"$START_SCRIPT\" >/dev/null 2>&1 &' > /etc/profile.d/codespace-telegram-agent.sh && chmod +x /etc/profile.d/codespace-telegram-agent.sh" 2>/dev/null || true
  fi
fi

echo "🔄 Starting Telegram Bridge agent process..."
pkill -f "node.*agent.js" || true
nohup node "$AGENT_DIR/agent.js" "${WORKER_URL}" "${AGENT_SECRET}" "${CODESPACE_NAME}" "${PUBLIC_TTYD_URL}" "${TARGET_CHAT_ID}" > "$AGENT_DIR/agent.log" 2>&1 &

echo "============================================================"
echo "🎉 SUCCESS! ttyd Web Terminal & Multi-Hook Auto-Boot active."
echo "📱 Telegram notification sent to your bot!"
echo "============================================================"
