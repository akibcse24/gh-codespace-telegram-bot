const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const WORKER_URL = process.argv[2];
const AGENT_SECRET = process.argv[3];
const CODESPACE_NAME = process.argv[4] || process.env.CODESPACE_NAME || process.env.HOSTNAME;
let PUBLIC_TUNNEL_URL = process.argv[5] || "";
let TARGET_CHAT_ID = process.argv[6] || process.env.CHAT_ID || "";

if (PUBLIC_TUNNEL_URL && (!PUBLIC_TUNNEL_URL.startsWith('https://') || PUBLIC_TUNNEL_URL.includes('Binary file') || PUBLIC_TUNNEL_URL.includes('serveo.net'))) {
  PUBLIC_TUNNEL_URL = "";
}

if (TARGET_CHAT_ID === 'YOUR_CHAT_ID') {
  TARGET_CHAT_ID = "";
}

if (!WORKER_URL || !AGENT_SECRET || !CODESPACE_NAME) {
  console.error("Usage: node agent.js <WORKER_URL> <AGENT_SECRET> <CODESPACE_NAME> [PUBLIC_TUNNEL_URL] [CHAT_ID]");
  process.exit(1);
}

console.log(`[Agent] Started for Codespace: ${CODESPACE_NAME}`);

function checkUrlHttpReachable(targetUrl) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const req = client.request(parsedUrl, { method: 'HEAD', timeout: 3000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

async function findTunnelUrlInLogs() {
  const homeDir = process.env.HOME || '/root';
  const agentDir = path.join(homeDir, '.codespace-telegram-agent');

  // Check 0: GitHub Native Port Forwarding
  const ghNativeUrl = `https://${CODESPACE_NAME}-7681.app.github.dev`;
  if (await checkUrlHttpReachable(ghNativeUrl)) {
    return ghNativeUrl;
  }

  const logFiles = [
    { file: path.join(agentDir, 'cloudflared.log'), regex: /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/g },
    { file: path.join(agentDir, 'pinggy.log'), regex: /https:\/\/[a-zA-Z0-9.-]+\.(pinggy\.online|pinggy\.link)/g },
  ];

  for (const item of logFiles) {
    try {
      if (fs.existsSync(item.file)) {
        const content = fs.readFileSync(item.file, 'utf8');
        const matches = content.match(item.regex);
        if (matches && matches.length > 0) {
          for (let idx = matches.length - 1; idx >= Math.max(0, matches.length - 5); idx--) {
            const candidate = matches[idx];
            if (candidate && candidate.startsWith('https://') && !candidate.includes('Binary file') && !candidate.includes('serveo.net')) {
              if (await checkUrlHttpReachable(candidate)) {
                return candidate;
              }
            }
          }
        }
      }
    } catch (e) {}
  }
  return "";
}

let lastNotifiedUrl = "";

async function notifyOnline() {
  let detected = "";
  if (PUBLIC_TUNNEL_URL && PUBLIC_TUNNEL_URL.startsWith('https://') && !PUBLIC_TUNNEL_URL.includes('Binary file') && !PUBLIC_TUNNEL_URL.includes('serveo.net')) {
    if (await checkUrlHttpReachable(PUBLIC_TUNNEL_URL)) {
      detected = PUBLIC_TUNNEL_URL;
    }
  }

  if (!detected) {
    detected = await findTunnelUrlInLogs();
  }

  if (!detected) {
    console.log('[Agent] Waiting for live HTTPS tunnel before notifying Worker...');
    return;
  }

  PUBLIC_TUNNEL_URL = detected;

  if (lastNotifiedUrl && lastNotifiedUrl === detected) {
    return;
  }

  console.log(`[Agent] Sending notify-online to Worker... Tunnel URL: ${detected}`);

  try {
    const payload = JSON.stringify({
      codespaceName: CODESPACE_NAME,
      secret: AGENT_SECRET,
      publicTunnelUrl: detected,
      chatId: TARGET_CHAT_ID || undefined
    });

    const url = new URL(`${WORKER_URL}/agent/notify-online`);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          lastNotifiedUrl = detected;
          console.log(`[Agent] notify-online success! URL registered: ${detected}`);
        }
      });
    });

    req.on('error', (e) => console.error("[Agent] Notify error:", e.message));
    req.write(payload);
    req.end();
  } catch (err) {
    console.error("[Agent] Notify exception:", err);
  }
}

// 1. Polling for legacy /sh single commands
async function pollCommands() {
  try {
    const url = `${WORKER_URL}/agent/poll?codespace_name=${encodeURIComponent(CODESPACE_NAME)}&secret=${encodeURIComponent(AGENT_SECRET)}`;
    const client = url.startsWith('https') ? https : http;

    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(data);
            if (json.commands && json.commands.length > 0) {
              for (const cmdObj of json.commands) {
                executeCommand(cmdObj);
              }
            }
          }
        } catch (e) {
          console.error("[Agent] JSON parse error:", e);
        }
      });
    }).on('error', err => {
      console.error("[Agent] Poll fetch error:", err.message);
    });
  } catch (err) {
    console.error("[Agent] Poll exception:", err);
  }
}

function executeCommand(cmdObj) {
  console.log(`[Agent] Executing command ${cmdObj.id}: ${cmdObj.command}`);
  const startTime = Date.now();

  exec(cmdObj.command, { maxBuffer: 1024 * 1024 * 5, env: process.env }, (error, stdout, stderr) => {
    const executionTimeMs = Date.now() - startTime;
    const exitCode = error ? (error.code || 1) : 0;

    const payload = JSON.stringify({
      id: cmdObj.id,
      command: cmdObj.command,
      codespaceName: CODESPACE_NAME,
      stdout: stdout || '',
      stderr: stderr || (error ? error.message : ''),
      exitCode,
      executionTimeMs,
      secret: AGENT_SECRET,
      chatId: cmdObj.chatId || TARGET_CHAT_ID
    });

    const url = new URL(`${WORKER_URL}/agent/result`);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      console.log(`[Agent] Result sent for ${cmdObj.id}, status: ${res.statusCode}`);
    });

    req.on('error', (e) => {
      console.error("[Agent] Send result error:", e.message);
    });

    req.write(payload);
    req.end();
  });
}

notifyOnline();
setInterval(notifyOnline, 5000);
setInterval(pollCommands, 3000);
pollCommands();
