#!/bin/bash
set -e

echo "🚀 Installing GitHub Codespace Telegram Bridge Agent..."

WORKER_URL="${WORKER_URL:-https://your-worker.workers.dev}"
AGENT_SECRET="${AGENT_SECRET:-YOUR_SECRET}"
CODESPACE_NAME="${CODESPACE_NAME:-$HOSTNAME}"

mkdir -p ~/.codespace-telegram-agent
curl -sSL "${WORKER_URL}/agent/agent.js" -o ~/.codespace-telegram-agent/agent.js

echo "✅ Agent script downloaded."

nohup node ~/.codespace-telegram-agent/agent.js "$WORKER_URL" "$AGENT_SECRET" "$CODESPACE_NAME" > ~/.codespace-telegram-agent/agent.log 2>&1 &

echo "🎉 Agent running in background! Logs available at ~/.codespace-telegram-agent/agent.log"
