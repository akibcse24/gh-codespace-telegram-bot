import { escapeHtml, TelegramBot } from './telegram';
import { Env } from './types';

interface PendingHttpResponse {
  resolve: (res: Response) => void;
  reject: (err: any) => void;
  timeout: any;
}

export class TTYDWorkerTunnel {
  private static tunnelAgents = new Map<string, WebSocket>(); // codespaceName -> WebSocket
  private static pendingHttpReqs = new Map<string, PendingHttpResponse>(); // reqId -> PendingHttpResponse
  private static clientSockets = new Map<string, Set<WebSocket>>(); // codespaceName -> Set<WebSocket>

  public static registerTunnelAgent(codespaceName: string, ws: WebSocket, env: Env) {
    this.tunnelAgents.set(codespaceName, ws);
    console.log(`[TTYDWorkerTunnel] Agent connected for codespace ${codespaceName}`);

    ws.addEventListener('message', async (event) => {
      const dataStr = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);

      if (dataStr.trim().startsWith('{') && dataStr.trim().endsWith('}')) {
        try {
          const json = JSON.parse(dataStr);

          // Handle HTTP Proxy Response from ttyd
          if (json.type === 'http_res' && json.id) {
            const pending = this.pendingHttpReqs.get(json.id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingHttpReqs.delete(json.id);

              const bodyBuffer = Uint8Array.from(atob(json.body || ''), (c) => c.charCodeAt(0));
              const headers = new Headers();
              if (json.headers) {
                for (const [k, v] of Object.entries(json.headers)) {
                  if (typeof v === 'string') headers.set(k, v);
                }
              }

              pending.resolve(new Response(bodyBuffer, { status: json.status || 200, headers }));
            }
            return;
          }

          // Handle Command Execution Result
          if (json.type === 'cmd_result') {
            const bot = new TelegramBot(env);
            const targetChatId = json.chatId;

            if (targetChatId) {
              const isSuccess = json.exitCode === 0;
              const emoji = isSuccess ? '✅' : '❌';
              const output = json.stdout || json.stderr || '(no output)';

              const resultMsg = `${emoji} <b>Command Executed:</b> <code>${escapeHtml(json.id || '')}</code>
🖥️ <b>Target:</b> <code>${escapeHtml(codespaceName)}</code> (Exit Code: ${json.exitCode}, Time: ${json.executionTimeMs}ms)

<pre>${escapeHtml(output)}</pre>`;

              await bot.sendMessage(targetChatId, resultMsg);
            }
            return;
          }
        } catch (e) {
          // Fall through to WebSocket frame relay
        }
      }

      // Relay ttyd WebSocket frame to browser client
      const clients = this.clientSockets.get(codespaceName);
      if (clients) {
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(event.data);
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      console.log(`[TTYDWorkerTunnel] Agent disconnected for ${codespaceName}`);
      this.tunnelAgents.delete(codespaceName);
    });
  }

  public static sendCommandViaWebSocket(codespaceName: string, cmd: any, chatId: number): boolean {
    const ws = this.tunnelAgents.get(codespaceName);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'exec_cmd',
          id: cmd.id,
          command: cmd.command,
          chatId,
        }));
        return true;
      } catch (e) {}
    }
    return false;
  }

  public static async proxyHttpRequest(codespaceName: string, path: string, method: string, headers: Headers, body?: ArrayBuffer): Promise<Response> {
    const agentWs = this.tunnelAgents.get(codespaceName);
    if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
      return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <title>ttyd Agent Offline</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; text-align: center; max-width: 420px; }
    .spinner { border: 3px solid #30363d; border-top: 3px solid #58a6ff; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; margin: 16px auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h3 style="color: #58a6ff;">Waiting for ttyd Agent inside Codespace...</h3>
    <div class="spinner"></div>
    <p style="font-size: 13px; color: #8b949e;">Codespace <code>${escapeHtml(codespaceName)}</code> agent is connecting to Cloudflare Worker. Retrying in 3 seconds...</p>
  </div>
</body>
</html>`, { status: 503, headers: { 'Content-Type': 'text/html' } });
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => { headerObj[k] = v; });

    let base64Body = '';
    if (body && body.byteLength > 0) {
      base64Body = btoa(String.fromCharCode(...new Uint8Array(body)));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHttpReqs.delete(reqId);
        resolve(new Response('Gateway Timeout: ttyd agent did not respond in 10s', { status: 504 }));
      }, 10000);

      this.pendingHttpReqs.set(reqId, { resolve, reject, timeout });

      agentWs.send(JSON.stringify({
        id: reqId,
        type: 'http_req',
        method,
        path,
        headers: headerObj,
        body: base64Body,
      }));
    });
  }

  public static registerClientSocket(codespaceName: string, ws: WebSocket) {
    let clients = this.clientSockets.get(codespaceName);
    if (!clients) {
      clients = new Set<WebSocket>();
      this.clientSockets.set(codespaceName, clients);
    }
    clients.add(ws);

    ws.addEventListener('message', (event) => {
      const agentWs = this.tunnelAgents.get(codespaceName);
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(event.data);
      }
    });

    ws.addEventListener('close', () => {
      const set = this.clientSockets.get(codespaceName);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.clientSockets.delete(codespaceName);
      }
    });
  }
}
