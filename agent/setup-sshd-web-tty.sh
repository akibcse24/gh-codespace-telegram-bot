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
echo "🚀 Setting up OpenSSH Server, ttyd & Public Tunnel..."
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

mkdir -p ~/.codespace-telegram-agent
rm -f ~/.codespace-telegram-agent/*.log

echo "📦 Installing / Checking ttyd web terminal binary..."
if ! command -v ttyd >/dev/null 2>&1 && [ ! -f ~/.codespace-telegram-agent/ttyd ]; then
  echo "📥 Downloading ttyd binary..."
  curl -sSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" -o ~/.codespace-telegram-agent/ttyd
  chmod +x ~/.codespace-telegram-agent/ttyd
  TTYD_BIN="~/.codespace-telegram-agent/ttyd"
else
  if command -v ttyd >/dev/null 2>&1; then
    TTYD_BIN="ttyd"
  else
    TTYD_BIN="~/.codespace-telegram-agent/ttyd"
  fi
fi

echo "🖥️ Starting ttyd server on 0.0.0.0:7681..."
pkill -f "ttyd" || true
eval "nohup $TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > ~/.codespace-telegram-agent/ttyd.log 2>&1 &"

sleep 2

PUBLIC_TTYD_URL=""
if command -v gh >/dev/null 2>&1; then
  echo "🌐 Setting up GitHub Codespaces Native Public Port 7681..."
  gh codespace ports visibility 7681:public -c "$CODESPACE_NAME" 2>/dev/null || true
  GH_APP_URL="https://${CODESPACE_NAME}-7681.app.github.dev"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$GH_APP_URL" || true)
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "401" ]; then
    PUBLIC_TTYD_URL="$GH_APP_URL"
    echo "✅ GitHub Native Tunnel active: ${PUBLIC_TTYD_URL}"
  fi
fi

echo "🌐 Launching Zero-Login Public Tunnels for ttyd (Cloudflare & Pinggy)..."
pkill -f "cloudflared" || true
pkill -f "ssh.*pinggy" || true

if ! command -v cloudflared >/dev/null 2>&1 && [ ! -f ~/.codespace-telegram-agent/cloudflared ]; then
  echo "📥 Downloading cloudflared binary for fast HTTPS tunnel..."
  curl -sSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o ~/.codespace-telegram-agent/cloudflared 2>/dev/null || true
  chmod +x ~/.codespace-telegram-agent/cloudflared 2>/dev/null || true
fi

CF_BIN=""
if command -v cloudflared >/dev/null 2>&1; then
  CF_BIN="cloudflared"
elif [ -f ~/.codespace-telegram-agent/cloudflared ]; then
  CF_BIN="~/.codespace-telegram-agent/cloudflared"
fi

if [ -n "$CF_BIN" ]; then
  eval "nohup $CF_BIN tunnel --url http://localhost:7681 > ~/.codespace-telegram-agent/cloudflared.log 2>&1 &"
fi

eval "nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > ~/.codespace-telegram-agent/pinggy.log 2>&1 &"

if [ -z "$PUBLIC_TTYD_URL" ]; then
  for i in {1..12}; do
    CANDIDATE=""
    if [ -f ~/.codespace-telegram-agent/cloudflared.log ]; then
      CANDIDATE=$(grep -a -oE "https://[a-zA-Z0-9.-]+\.trycloudflare\.com" ~/.codespace-telegram-agent/cloudflared.log | tail -n 1 || true)
    fi
    if [ -z "$CANDIDATE" ] && [ -f ~/.codespace-telegram-agent/pinggy.log ]; then
      CANDIDATE=$(grep -a -oE "https://[a-zA-Z0-9.-]+\.(pinggy\.online|pinggy\.link)" ~/.codespace-telegram-agent/pinggy.log | tail -n 1 || true)
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
curl -sSL "${WORKER_URL}/agent/agent.js" -o ~/.codespace-telegram-agent/agent.js

AUTO_START_LINE="[ -f ~/.codespace-telegram-agent/agent.js ] && pgrep -f 'node.*agent.js' > /dev/null || (nohup $TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > ~/.codespace-telegram-agent/ttyd.log 2>&1 & ; [ -f ~/.codespace-telegram-agent/cloudflared ] && nohup ~/.codespace-telegram-agent/cloudflared tunnel --url http://localhost:7681 > ~/.codespace-telegram-agent/cloudflared.log 2>&1 & ; nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > ~/.codespace-telegram-agent/pinggy.log 2>&1 & ; nohup node ~/.codespace-telegram-agent/agent.js \"${WORKER_URL}\" \"${AGENT_SECRET}\" \"${CODESPACE_NAME}\" \"${PUBLIC_TTYD_URL}\" \"${TARGET_CHAT_ID}\" > ~/.codespace-telegram-agent/agent.log 2>&1 &)"

if ! grep -q "codespace-telegram-agent" ~/.bashrc 2>/dev/null; then
  echo "" >> ~/.bashrc
  echo "# Auto-start ttyd & Telegram Agent" >> ~/.bashrc
  echo "$AUTO_START_LINE" >> ~/.bashrc
  echo "✅ Configured auto-start in ~/.bashrc"
fi

if [ -f ~/.zshrc ] && ! grep -q "codespace-telegram-agent" ~/.zshrc 2>/dev/null; then
  echo "" >> ~/.zshrc
  echo "# Auto-start ttyd & Telegram Agent" >> ~/.zshrc
  echo "$AUTO_START_LINE" >> ~/.zshrc
  echo "✅ Configured auto-start in ~/.zshrc"
fi

echo "🔄 Starting Telegram Bridge agent process..."
pkill -f "node.*agent.js" || true
nohup node ~/.codespace-telegram-agent/agent.js "${WORKER_URL}" "${AGENT_SECRET}" "${CODESPACE_NAME}" "${PUBLIC_TTYD_URL}" "${TARGET_CHAT_ID}" > ~/.codespace-telegram-agent/agent.log 2>&1 &

echo "============================================================"
echo "🎉 SUCCESS! ttyd Web Terminal & Tunnel active."
echo "📱 Telegram notification sent to your bot!"
echo "============================================================"
