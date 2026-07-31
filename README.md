# 🤖 GitHub Codespace Control Telegram Bot (Cloudflare Worker)

A serverless Telegram Bot running on **Cloudflare Workers** to manage GitHub Codespaces and execute remote terminal commands directly inside your Codespaces via Telegram.

---

## ✨ Features

- 🟢 **Manage Codespaces**: List, Start, Stop, Rebuild, and Delete GitHub Codespaces with interactive Telegram Inline Keyboards.
- 💻 **Remote Terminal Shell**: Execute bash/sh commands inside active Codespaces (`/sh <command>`) and receive real-time stdout/stderr output.
- 🔒 **Secure Authorization**: Restrict bot access to specified Telegram User ID(s) and secure Agent polling with secrets.
- ⚡ **Serverless & Fast**: Hosted on Cloudflare Workers with minimal latency and 0 continuous hosting server cost.

---

## 🛠️ Prerequisites

1. **Telegram Bot Token**:
   - Talk to [@BotFather](https://t.me/BotFather) on Telegram and create a new bot to get your `TELEGRAM_BOT_TOKEN`.
   - Get your Telegram User ID (e.g. using [@userinfobot](https://t.me/userinfobot)).

2. **GitHub Personal Access Token (PAT)**:
   - Go to [GitHub Settings -> Developer Settings -> Personal Access Tokens (Tokens classic)](https://github.com/settings/tokens).
   - Generate a new token with scopes: `codespace`, `repo`, `workflow`.

3. **Cloudflare Account & Wrangler CLI**:
   - Install dependencies: `npm install`
   - Login to Cloudflare: `npx wrangler login`

---

## 🚀 Setup & Deployment Guide

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Set Cloudflare Secrets
Run the following commands to set your environment secrets in Cloudflare Workers:

```bash
# 1. Telegram Bot Token from @BotFather
npx wrangler secret put TELEGRAM_BOT_TOKEN

# 2. Your Telegram User ID (comma-separated if multiple, e.g. "123456789,987654321")
npx wrangler secret put TELEGRAM_ALLOWED_USERS

# 3. GitHub Personal Access Token
npx wrangler secret put GITHUB_PAT

# 4. Agent Shared Secret (Create any random string, e.g., "my_super_secret_agent_key_123")
npx wrangler secret put AGENT_SECRET
```

### Step 3: Create Cloudflare KV Namespace (Optional for Session Storage)
To persist active codespace selection and command queues across Worker isolate restarts:

```bash
npx wrangler kv:namespace create BOT_KV
```
Update your `wrangler.json` with the outputted `id`:
```json
"kv_namespaces": [
  {
    "binding": "BOT_KV",
    "id": "<YOUR_KV_NAMESPACE_ID>"
  }
]
```

### Step 4: Deploy Worker to Cloudflare
```bash
npx wrangler deploy
```

---

## 🌐 Step 5: Register Telegram Webhook

Once deployed, copy your worker URL (e.g. `https://gh-codespace-telegram-bot.<your-subdomain>.workers.dev`) and open in your browser:

```
https://<YOUR_WORKER_URL>/set-webhook
```

You will receive a confirmation response from Telegram:
```json
{
  "webhookUrl": "https://<YOUR_WORKER_URL>/webhook",
  "telegramResponse": { "ok": true, "result": true, "description": "Webhook was set" }
}
```

---

## 📱 Bot Commands in Telegram

| Command | Description |
| :--- | :--- |
| `/start` | Welcome message, authentication check, and installer info |
| `/codespaces` or `/cs` | View interactive card menu of all your GitHub Codespaces |
| `/status` | View currently selected active Codespace details |
| `/sh <command>` | Run a bash command in the selected active Codespace |
| `/agent` | Get one-line installer command for Codespaces |

---

## 💻 Enabling Remote Shell inside Codespaces

To run terminal commands (`/sh <cmd>`) in a Codespace:

1. Open your GitHub Codespace.
2. In the terminal, run the installer command provided by `/agent` in Telegram:
   ```bash
   curl -sSL https://<YOUR_WORKER_URL>/agent/install.sh | bash
   ```
3. The lightweight agent will run automatically in the background and connect to your Cloudflare Worker!
4. Send commands in Telegram like `/sh pwd`, `/sh git status`, `/sh npm test`, or `/sh docker ps`!
