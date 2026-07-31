import { Hono } from 'hono';
import { PureCodeAI } from './ai';
import { BridgeManager } from './bridge';
import { GitHubCodespacesAPI } from './github';
import { SubAgentRegistry } from './subagents';
import { escapeHtml, TelegramBot } from './telegram';
import { CommandResult, Env, TelegramUpdate } from './types';

const app = new Hono<{ Bindings: Env }>();

function getAgentSecret(env: Env): string {
  return env.AGENT_SECRET || 'super_secret_agent_key_123';
}

function getBotToken(env: Env): string {
  return env.TELEGRAM_BOT_TOKEN || '8715755681:AAFqMw42pg92WgQrlu8K3K5tPlN0pODWcAE';
}

// Helper to get GitHub client for active account
async function getGitHubClient(env: Env, bridge: BridgeManager, userId: number): Promise<{ gh: GitHubCodespacesAPI; activeAlias: string }> {
  const activeAcc = await bridge.getActiveAccount(userId);
  const pat = activeAcc?.pat || env.GITHUB_PAT || '';
  const activeAlias = activeAcc?.alias || 'default';
  return {
    gh: new GitHubCodespacesAPI(env, pat),
    activeAlias,
  };
}

// Healthcheck
app.get('/health', (c) => c.text('OK - GitHub Codespaces Telegram Bot Worker is running'));

// Manual / Cron Trigger test endpoint for Keep-Alive
app.get('/cron/keepalive', async (c) => {
  const subagents = new SubAgentRegistry(c.env);
  const results = await subagents.runAutoSchedulerHealthCheck();
  return c.json({ keepaliveCheck: results });
});

// Setup Telegram Webhook & Commands Menu endpoint
app.get('/set-webhook', async (c) => {
  const token = getBotToken(c.env);
  const workerUrl = new URL(c.req.url).origin;
  const webhookUrl = `${workerUrl}/webhook`;

  // Set Webhook
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = await res.json();

  // Set Bot Commands Menu
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'codespaces', description: 'List and manage GitHub Codespaces' },
        { command: 'create_cs', description: 'Create new GitHub Codespace' },
        { command: 'accounts', description: 'Manage GitHub PAT tokens and Accounts' },
        { command: 'status', description: 'View active Codespace and bot status' },
        { command: 'agents', description: 'Run 10 Autonomous Smart Sub-Agents' },
        { command: 'sh', description: 'Run bash command in active Codespace' },
        { command: 'agent', description: 'Get Codespace agent installer script' },
        { command: 'start', description: 'Start bot and welcome menu' },
      ],
    }),
  });

  return c.json({ webhookUrl, telegramResponse: data });
});

// Direct HTTP Redirect to ttyd Web Terminal Tunnel
app.get('/tty', async (c) => {
  const codespaceName = c.req.query('codespace_name');
  const secret = c.req.query('secret');

  if (!codespaceName || secret !== getAgentSecret(c.env)) {
    return c.text('Unauthorized or missing parameters', 401);
  }

  const bridge = new BridgeManager(c.env);
  let ttydUrl = await bridge.getTtydUrl(codespaceName);

  if (!ttydUrl && codespaceName) {
    // Direct GitHub Native Port 7681 Tunnel Fallback
    ttydUrl = `https://${codespaceName}-7681.app.github.dev`;
  }

  if (ttydUrl && ttydUrl.startsWith('https://')) {
    // Direct HTTP 302 Redirect to live ttyd web terminal
    return c.redirect(ttydUrl, 302);
  }

  // Loading screen if tunnel URL is still initializing
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <title>Connecting to ttyd...</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; text-align: center; max-width: 420px; }
    .spinner { border: 3px solid #30363d; border-top: 3px solid #58a6ff; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; margin: 16px auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h3 style="color: #58a6ff;">Connecting to ttyd Web Terminal...</h3>
    <div class="spinner"></div>
    <p style="font-size: 13px; color: #8b949e;">Fetching live Tunnel URL for <code>${escapeHtml(codespaceName)}</code>... Retrying in 3 seconds.</p>
  </div>
</body>
</html>`);
});

// Alias for /ttyd
app.get('/ttyd', (c) => app.request('/tty', {}, c.env));

// WebSocket Endpoint for Agent (Command Relay)
app.get('/ws/agent', (c) => {
  return c.text('OK');
});

// Endpoint called by Agent to poll pending shell commands
app.get('/agent/poll', async (c) => {
  const csName = c.req.query('codespace_name');
  const secret = c.req.query('secret');

  if (!csName || secret !== getAgentSecret(c.env)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const bridge = new BridgeManager(c.env);
  const commands = await bridge.popPendingCommands(csName);
  return c.json({ commands });
});

// Endpoint called by Agent to post command execution results back to Telegram
app.post('/agent/result', async (c) => {
  try {
    const body: CommandResult & { secret: string } = await c.req.json();
    if (!body || body.secret !== getAgentSecret(c.env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const bridge = new BridgeManager(c.env);
    await bridge.saveCommandResult(body);

    const targetChatId = body.chatId || (await bridge.getLastChatId());

    if (targetChatId) {
      const bot = new TelegramBot(c.env);
      const isSuccess = body.exitCode === 0;
      const emoji = isSuccess ? '✅' : '❌';
      const output = body.stdout || body.stderr || '(no output)';
      const liveTtyUrl = await bridge.getTtydUrl(body.codespaceName || '');

      // SubAgent #8: Log Diagnostic Parser
      const subagents = new SubAgentRegistry(c.env);
      const diagnostics = subagents.analyzeLogOutput(output);

      const ttyHeader = liveTtyUrl ? `\n🖥️ <b>Live Web Terminal:</b> ${liveTtyUrl}\n` : '';
      const cmdTitle = body.command ? ` <code>$ ${escapeHtml(body.command)}</code>` : '';

      const resultMsg = `${emoji} <b>Command Output:</b>${cmdTitle}
🖥️ <b>Target:</b> <code>${escapeHtml(body.codespaceName || '')}</code> (Exit Code: ${body.exitCode}, Time: ${body.executionTimeMs}ms)${ttyHeader}
<pre>${escapeHtml(output)}</pre>${diagnostics}`;

      const kb = liveTtyUrl
        ? {
            inline_keyboard: [[{ text: '🖥️ Open TTY Terminal', url: liveTtyUrl }]],
          }
        : undefined;

      await bot.sendMessage(targetChatId, resultMsg, { reply_markup: kb });
    }

    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in /agent/result:', err);
    return c.json({ success: false, error: err.message }, 200);
  }
});

// Endpoint called by Agent on boot to notify Telegram of ttyd Web Terminal URL
app.post('/agent/notify-online', async (c) => {
  try {
    const body: { codespaceName: string; secret: string; publicTunnelUrl?: string; chatId?: number | string } = await c.req.json();

    if (!body || body.secret !== getAgentSecret(c.env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const bot = new TelegramBot(c.env);
    const bridge = new BridgeManager(c.env);

    // Validate HTTPS URL
    let validTunnelUrl = body.publicTunnelUrl;
    if (validTunnelUrl && !validTunnelUrl.startsWith('https://')) {
      validTunnelUrl = undefined;
    }

    if (validTunnelUrl) {
      await bridge.setTtydUrl(body.codespaceName, validTunnelUrl);
    }

    const workerOrigin = new URL(c.req.url).origin;
    const workerRedirectUrl = `${workerOrigin}/tty?codespace_name=${encodeURIComponent(body.codespaceName)}&secret=${encodeURIComponent(body.secret)}`;
    const finalTtydUrl = validTunnelUrl || workerRedirectUrl;

    if (body.chatId) {
      const cId = typeof body.chatId === 'number' ? body.chatId : parseInt(String(body.chatId), 10);
      if (!isNaN(cId)) {
        await bridge.setLastChatId(cId);
      }
    }

    const allowedUsers = (c.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((u) => u.trim()).filter(Boolean);
    const allChatIds = await bridge.getChatIds();

    const recipients = new Set<number>();
    for (const uStr of allowedUsers) {
      const uId = parseInt(uStr, 10);
      if (!isNaN(uId)) recipients.add(uId);
    }
    for (const cId of allChatIds) {
      recipients.add(cId);
    }

    if (recipients.size === 0) {
      console.log('[notify-online] No active Telegram chatId recorded yet.');
      return c.json({
        success: true,
        message: 'Agent online, but no active Telegram chat ID recorded yet. Please send /start to your bot once.',
        ttyUrl: finalTtydUrl,
      });
    }

    const message = `🚀 <b>GitHub Codespace ttyd Web Terminal is ONLINE!</b>

🟢 <b>Codespace Target:</b> <code>${escapeHtml(body.codespaceName)}</code> is active and online.

🖥️ <b>ttyd Web Terminal Link:</b>
${finalTtydUrl}

🔑 <b>GH CLI SSH Access Command:</b>
<code>gh codespace ssh -c ${escapeHtml(body.codespaceName)}</code>`;

    const kb = {
      inline_keyboard: [
        [
          {
            text: '🖥️ Open ttyd Web Terminal',
            url: finalTtydUrl,
          },
        ],
      ],
    };

    const results: string[] = [];
    for (const userId of recipients) {
      try {
        await bot.sendMessage(userId, message, { reply_markup: kb, disable_web_page_preview: false });
        results.push(`Sent to ${userId}`);
      } catch (e: any) {
        console.error(`Failed to send notification to user ${userId}:`, e);
        results.push(`Error for ${userId}: ${e.message}`);
      }
    }

    return c.json({ success: true, ttyUrl: finalTtydUrl, results });
  } catch (err: any) {
    console.error('Error in /agent/notify-online:', err);
    return c.json({ success: false, error: err.message }, 200);
  }
});

// Telegram Webhook Handler
app.post('/webhook', async (c) => {
  const bot = new TelegramBot(c.env);
  const bridge = new BridgeManager(c.env);
  const subagents = new SubAgentRegistry(c.env);
  const workerOrigin = new URL(c.req.url).origin;
  const agentSecret = getAgentSecret(c.env);

  try {
    const update: TelegramUpdate = await c.req.json();

    // 1. Handle Callback Queries
    if (update.callback_query) {
      const cb = update.callback_query;
      const userId = cb.from.id;
      const username = cb.from.username;
      const chatId = cb.message?.chat.id;
      const messageId = cb.message?.message_id;

      if (chatId) {
        await bridge.setLastChatId(chatId);
      }

      if (!bot.isUserAllowed(userId, username)) {
        await bot.answerCallbackQuery(cb.id, '❌ Unauthorized user', true);
        return c.text('OK');
      }

      const data = cb.data || '';
      await bot.answerCallbackQuery(cb.id);

      if (!chatId || !messageId) return c.text('OK');

      const activeCs = await bridge.getActiveCodespace(userId);
      const { gh, activeAlias } = await getGitHubClient(c.env, bridge, userId);

      if (data === 'list') {
        try {
          const list = await gh.listCodespaces();
          const kb = bot.renderCodespacesListKeyboard(list, activeCs);
          await bot.editMessageText(
            chatId,
            messageId,
            `<b>🖥️ Your GitHub Codespaces (${list.length})</b> [Account: <code>${escapeHtml(activeAlias)}</code>]:\nSelect a codespace to view options or manage state.`,
            { reply_markup: kb }
          );
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Error fetching Codespaces: ${escapeHtml(err.message)}`);
        }
      } else if (data === 'agents_menu') {
        const kb = {
          inline_keyboard: [
            [{ text: '🏥 1. System Health Agent', callback_data: 'run_agent:health' }],
            [{ text: '🌿 3. Git Workflow Agent', callback_data: 'run_agent:git' }],
            [{ text: '⚡ 6. Process Manager Agent', callback_data: 'run_agent:process' }],
            [{ text: '🌐 7. Network Port Scanner', callback_data: 'run_agent:ports' }],
            [{ text: '📋 Back to List', callback_data: 'list' }],
          ],
        };
        await bot.editMessageText(
          chatId,
          messageId,
          `🤖 <b>10 Autonomous Smart Sub-Agents (Pure Code AI)</b>\nSelect an agent to execute on target <code>${escapeHtml(activeCs || 'none')}</code>:`,
          { reply_markup: kb }
        );
      } else if (data.startsWith('run_agent:')) {
        const agentType = data.split(':')[1];
        if (!activeCs) {
          await bot.sendMessage(chatId, '⚠️ Please select a active Codespace target first using /codespaces');
          return c.text('OK');
        }

        let resp = '';
        if (agentType === 'health') resp = await subagents.runSystemHealthAgent(chatId, activeCs);
        else if (agentType === 'git') resp = await subagents.runGitWorkflowAgent(chatId, activeCs);
        else if (agentType === 'process') resp = await subagents.runProcessManagerAgent(chatId, activeCs);
        else if (agentType === 'ports') resp = await subagents.runPortScannerAgent(chatId, activeCs);

        await bot.sendMessage(chatId, resp);
      } else if (data === 'create_prompt') {
        const kb = bot.renderCreateTemplateKeyboard();
        await bot.editMessageText(
          chatId,
          messageId,
          `<b>➕ Create New GitHub Codespace</b>\n\nSelect a starter template below, or type a custom repository command:\n<code>/create_cs owner/repository_name</code>\n\n<i>Example:</i> <code>/create_cs github/codespaces-express</code>`,
          { reply_markup: kb }
        );
      } else if (data.startsWith('create_repo:')) {
        const repoFullName = data.split(':')[1];
        await bot.editMessageText(
          chatId,
          messageId,
          `⏳ Creating new Codespace for repository <code>${escapeHtml(repoFullName)}</code>... Please wait.`
        );
        try {
          const newCs = await gh.createCodespace(repoFullName);
          await bridge.setActiveCodespace(userId, newCs.name);
          await bridge.setManualStop(newCs.name, false);
          const cardText = bot.renderCodespaceCard(newCs, newCs.name, activeAlias);
          const kb = bot.renderCodespaceKeyboard(newCs, newCs.name, workerOrigin, agentSecret);
          await bot.sendMessage(
            chatId,
            `🎉 <b>Codespace Created Successfully!</b>\n\n${cardText}`,
            { reply_markup: kb }
          );
        } catch (err: any) {
          await bot.sendMessage(
            chatId,
            `❌ Failed to create Codespace for <code>${escapeHtml(repoFullName)}</code>: ${escapeHtml(err.message)}`
          );
        }
      } else if (data === 'accounts') {
        const accounts = await bridge.getAccounts(userId);
        const kb = bot.renderAccountsKeyboard(accounts, activeAlias);
        await bot.editMessageText(
          chatId,
          messageId,
          `<b>🔑 GitHub API Accounts / PATs Manager</b>\n\nCurrent Active Account: <code>${escapeHtml(activeAlias)}</code>\nSelect an account below to switch GitHub credentials:`,
          { reply_markup: kb }
        );
      } else if (data.startsWith('use_account:')) {
        const alias = data.split(':')[1];
        const success = await bridge.setActiveAccount(userId, alias);
        if (success) {
          const accounts = await bridge.getAccounts(userId);
          const kb = bot.renderAccountsKeyboard(accounts, alias);
          await bot.editMessageText(
            chatId,
            messageId,
            `✅ Switched active GitHub Account to <b>${escapeHtml(alias)}</b>!\n\nUse button below to browse codespaces:`,
            { reply_markup: kb }
          );
        }
      } else if (data === 'add_account_info') {
        const infoMsg = `<b>➕ How to Add Additional GitHub Accounts / PATs:</b>\n\nSend a message in chat with the format:\n<code>/add_account &lt;alias_name&gt; &lt;github_pat_token&gt;</code>\n\n<b>Example:</b>\n<code>/add_account work ghp_xyz123456789...</code>\n\nGenerate your GitHub PAT with <code>codespace</code> and <code>repo</code> permissions on GitHub.`;
        const kb = {
          inline_keyboard: [[{ text: '📋 Back to Accounts', callback_data: 'accounts' }]],
        };
        await bot.editMessageText(chatId, messageId, infoMsg, { reply_markup: kb });
      } else if (data.startsWith('get:')) {
        const csName = data.split(':')[1];
        try {
          const cs = await gh.getCodespace(csName);
          const liveTtyUrl = await bridge.getTtydUrl(csName);
          const cardText = bot.renderCodespaceCard(cs, activeCs, activeAlias, liveTtyUrl);
          const kb = bot.renderCodespaceKeyboard(cs, activeCs, workerOrigin, agentSecret, liveTtyUrl);
          await bot.editMessageText(chatId, messageId, cardText, { reply_markup: kb });
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Error loading Codespace <code>${escapeHtml(csName)}</code>: ${escapeHtml(err.message)}`);
        }
      } else if (data.startsWith('start:')) {
        const csName = data.split(':')[1];
        await bridge.setManualStop(csName, false);
        await bot.editMessageText(
          chatId,
          messageId,
          `⏳ Starting Codespace <code>${escapeHtml(csName)}</code>... Please wait.`
        );
        try {
          await gh.startCodespace(csName);
          const cs = await gh.getCodespace(csName);
          const liveTtyUrl = await bridge.getTtydUrl(csName);
          const cardText = bot.renderCodespaceCard(cs, activeCs, activeAlias, liveTtyUrl);
          const kb = bot.renderCodespaceKeyboard(cs, activeCs, workerOrigin, agentSecret, liveTtyUrl);
          await bot.editMessageText(chatId, messageId, cardText, { reply_markup: kb });
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Start Failed: ${escapeHtml(err.message)}`);
        }
      } else if (data.startsWith('stop:')) {
        const csName = data.split(':')[1];
        await bridge.setManualStop(csName, true);
        await bot.editMessageText(
          chatId,
          messageId,
          `⏳ Stopping Codespace <code>${escapeHtml(csName)}</code>... (Manual stop recorded)`
        );
        try {
          await gh.stopCodespace(csName);
          const cs = await gh.getCodespace(csName);
          const liveTtyUrl = await bridge.getTtydUrl(csName);
          const cardText = bot.renderCodespaceCard(cs, activeCs, activeAlias, liveTtyUrl);
          const kb = bot.renderCodespaceKeyboard(cs, activeCs, workerOrigin, agentSecret, liveTtyUrl);
          await bot.editMessageText(chatId, messageId, cardText, { reply_markup: kb });
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Stop Failed: ${escapeHtml(err.message)}`);
        }
      } else if (data.startsWith('rebuild:')) {
        const csName = data.split(':')[1];
        await bot.editMessageText(
          chatId,
          messageId,
          `⏳ Rebuilding Codespace <code>${escapeHtml(csName)}</code>...`
        );
        try {
          await gh.rebuildCodespace(csName);
          const cs = await gh.getCodespace(csName);
          const liveTtyUrl = await bridge.getTtydUrl(csName);
          const cardText = bot.renderCodespaceCard(cs, activeCs, activeAlias, liveTtyUrl);
          const kb = bot.renderCodespaceKeyboard(cs, activeCs, workerOrigin, agentSecret, liveTtyUrl);
          await bot.editMessageText(chatId, messageId, cardText, { reply_markup: kb });
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Rebuild Failed: ${escapeHtml(err.message)}`);
        }
      } else if (data.startsWith('select:')) {
        const csName = data.split(':')[1];
        await bridge.setActiveCodespace(userId, csName);
        try {
          const cs = await gh.getCodespace(csName);
          const liveTtyUrl = await bridge.getTtydUrl(csName);
          const cardText = bot.renderCodespaceCard(cs, csName, activeAlias, liveTtyUrl);
          const kb = bot.renderCodespaceKeyboard(cs, csName, workerOrigin, agentSecret, liveTtyUrl);
          await bot.editMessageText(
            chatId,
            messageId,
            `🎯 Set active shell target to <b>${escapeHtml(cs.display_name || cs.name)}</b>!\n\n${cardText}`,
            { reply_markup: kb }
          );
        } catch (err: any) {
          await bot.sendMessage(chatId, `🎯 Set active target to <code>${escapeHtml(csName)}</code>.`);
        }
      } else if (data.startsWith('delete_prompt:')) {
        const csName = data.split(':')[1];
        const kb = {
          inline_keyboard: [
            [
              { text: '⚠️ Confirm Delete', callback_data: `delete_confirm:${csName}` },
              { text: '❌ Cancel', callback_data: `get:${csName}` },
            ],
          ],
        };
        await bot.editMessageText(
          chatId,
          messageId,
          `❓ Are you sure you want to delete Codespace <b>${escapeHtml(csName)}</b>? This action cannot be undone.`,
          { reply_markup: kb }
        );
      } else if (data.startsWith('delete_confirm:')) {
        const csName = data.split(':')[1];
        await bot.editMessageText(chatId, messageId, `⏳ Deleting Codespace <code>${escapeHtml(csName)}</code>...`);
        try {
          await gh.deleteCodespace(csName);
          await bridge.setManualStop(csName, false);
          await bot.editMessageText(
            chatId,
            messageId,
            `✅ Codespace <code>${escapeHtml(csName)}</code> has been deleted.`
          );
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Delete Failed: ${escapeHtml(err.message)}`);
        }
      }

      return c.text('OK');
    }

    // 2. Handle Text Messages
    if (update.message && update.message.text) {
      const msg = update.message;
      if (!msg.text) return c.text('OK');
      const chatId = msg.chat.id;
      const userId = msg.from?.id || chatId;
      const username = msg.from?.username;
      const text = msg.text.trim();

      await bridge.setLastChatId(chatId);

      if (!bot.isUserAllowed(userId, username)) {
        await bot.sendMessage(chatId, '❌ <b>Access Denied:</b> You are not authorized to use this bot.');
        return c.text('OK');
      }

      const activeCs = await bridge.getActiveCodespace(userId);
      const { gh, activeAlias } = await getGitHubClient(c.env, bridge, userId);

      // Command: /start
      if (text === '/start') {
        const installScriptCmd = `curl -sSL "${workerOrigin}/agent/setup-sshd-web-tty.sh?chat_id=${chatId}" | bash`;

        const welcomeText = `👋 <b>Welcome to GitHub Codespaces Bot!</b>

Control your GitHub Codespaces with native <b>ttyd Web Terminal</b> and 10 Pure-Code Smart Sub-Agents!

<b>Available Commands:</b>
/codespaces - List & manage Codespaces
/create_cs &lt;owner/repo&gt; - Create new Codespace
/accounts - Manage multiple GitHub PAT tokens & accounts
/agents - Run 10 Autonomous Smart Sub-Agents
/status - View active Codespace & status
/sh &lt;command&gt; - Run bash command in active Codespace
/agent - Get agent installation command for Codespace

<b>Current Active GitHub Account:</b> <code>${escapeHtml(activeAlias)}</code>

<b>ttyd Web Terminal Installer:</b>
To install ttyd Web Terminal & auto-start script inside Codespace:
<code>${installScriptCmd}</code>`;

        await bot.sendMessage(chatId, welcomeText);
        return c.text('OK');
      }

      // Command: /agents
      if (text === '/agents') {
        const kb = {
          inline_keyboard: [
            [{ text: '🏥 1. System Health Agent', callback_data: 'run_agent:health' }],
            [{ text: '🌿 3. Git Workflow Agent', callback_data: 'run_agent:git' }],
            [{ text: '⚡ 6. Process Manager Agent', callback_data: 'run_agent:process' }],
            [{ text: '🌐 7. Network Port Scanner', callback_data: 'run_agent:ports' }],
            [{ text: '📋 Back to List', callback_data: 'list' }],
          ],
        };
        await bot.sendMessage(
          chatId,
          `🤖 <b>10 Autonomous Smart Sub-Agents Engine</b>\n\n1. 🏥 <b>SystemHealthAgent</b> - CPU, RAM & Disk audit\n2. 🛡️ <b>KeepAliveGuardian</b> - Auto-recovery monitor\n3. 🌿 <b>GitWorkflowAgent</b> - Git status & branch inspector\n4. 🔒 <b>SecuritySentinel</b> - Command danger audit & filter\n5. 🤖 <b>TerminalNLPInterpreter</b> - Natural language to shell translator\n6. ⚡ <b>ProcessManagerAgent</b> - Top CPU processes & job manager\n7. 🌐 <b>NetworkPortScanner</b> - Active listening port & web app audit\n8. 🔍 <b>LogDiagnosticAgent</b> - Stack trace error analyzer & solution engine\n9. 🔑 <b>MultiAccountBroker</b> - Dynamic PAT rate-limit manager\n10. ⏱️ <b>AutoTaskScheduler</b> - Background cron scheduler\n\nSelect an agent below to execute on active target <code>${escapeHtml(activeCs || 'none')}</code>:`,
          { reply_markup: kb }
        );
        return c.text('OK');
      }

      // Command: /create_cs <owner/repo> [branch]
      if (text.startsWith('/create_cs')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
          const kb = bot.renderCreateTemplateKeyboard();
          await bot.sendMessage(
            chatId,
            `<b>➕ Create New GitHub Codespace</b>\n\nUsage:\n<code>/create_cs &lt;owner/repository_name&gt; [branch]</code>\n\n<b>Example:</b>\n<code>/create_cs github/codespaces-express</code>\n\nOr select a quick starter template below:`,
            { reply_markup: kb }
          );
          return c.text('OK');
        }

        const repoFullName = parts[1];
        const branch = parts[2] || 'main';

        const loadingMsg: any = await bot.sendMessage(
          chatId,
          `⏳ Creating new Codespace for repository <code>${escapeHtml(repoFullName)}</code> (branch: <code>${escapeHtml(branch)}</code>)...`
        );

        try {
          const newCs = await gh.createCodespace(repoFullName, branch);
          await bridge.setActiveCodespace(userId, newCs.name);
          await bridge.setManualStop(newCs.name, false);
          const cardText = bot.renderCodespaceCard(newCs, newCs.name, activeAlias);
          const kb = bot.renderCodespaceKeyboard(newCs, newCs.name, workerOrigin, agentSecret);
          await bot.editMessageText(
            chatId,
            loadingMsg.result.message_id,
            `🎉 <b>Codespace Created Successfully!</b>\n\n${cardText}`,
            { reply_markup: kb }
          );
        } catch (err: any) {
          await bot.sendMessage(
            chatId,
            `❌ Failed to create Codespace for <code>${escapeHtml(repoFullName)}</code>: ${escapeHtml(err.message)}`
          );
        }
        return c.text('OK');
      }

      // Command: /accounts
      if (text === '/accounts') {
        const accounts = await bridge.getAccounts(userId);
        const kb = bot.renderAccountsKeyboard(accounts, activeAlias);
        await bot.sendMessage(
          chatId,
          `<b>🔑 GitHub API Accounts / PATs Manager</b>\n\nCurrent Active Account: <code>${escapeHtml(activeAlias)}</code>\nSelect an account below to switch GitHub credentials, or use <code>/add_account &lt;alias&gt; &lt;pat&gt;</code> to add a new account.`,
          { reply_markup: kb }
        );
        return c.text('OK');
      }

      // Command: /add_account <alias> <pat>
      if (text.startsWith('/add_account')) {
        const parts = text.split(/\s+/);
        if (parts.length < 3) {
          await bot.sendMessage(
            chatId,
            '⚠️ Usage: <code>/add_account &lt;alias_name&gt; &lt;github_pat_token&gt;</code>\n\nExample:\n<code>/add_account work ghp_123456789...</code>'
          );
          return c.text('OK');
        }
        const alias = parts[1].toLowerCase();
        const pat = parts[2];

        try {
          const testGh = new GitHubCodespacesAPI(c.env, pat);
          const ghUser = await testGh.getAuthenticatedUser();
          await bridge.addAccount(userId, alias, pat);
          await bot.sendMessage(
            chatId,
            `✅ Successfully added GitHub Account <b>${escapeHtml(alias)}</b> (@${escapeHtml(ghUser.login)}) and set as active!`
          );
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Failed to validate PAT token: ${escapeHtml(err.message)}`);
        }
        return c.text('OK');
      }

      // Command: /remove_account <alias>
      if (text.startsWith('/remove_account')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
          await bot.sendMessage(chatId, '⚠️ Usage: <code>/remove_account &lt;alias_name&gt;</code>');
          return c.text('OK');
        }
        const alias = parts[1].toLowerCase();
        await bridge.removeAccount(userId, alias);
        await bot.sendMessage(chatId, `🗑️ Account <b>${escapeHtml(alias)}</b> has been removed.`);
        return c.text('OK');
      }

      // Command: /codespaces or /cs
      if (text === '/codespaces' || text === '/cs') {
        const loadingMsg: any = await bot.sendMessage(chatId, '⏳ Fetching your GitHub Codespaces...');
        try {
          const list = await gh.listCodespaces();
          if (list.length === 0) {
            const kb = bot.renderCreateTemplateKeyboard();
            await bot.sendMessage(
              chatId,
              `ℹ️ No active GitHub Codespaces found for account <code>${escapeHtml(activeAlias)}</code>.\n\nUse button below to create your first Codespace!`,
              { reply_markup: kb }
            );
            return c.text('OK');
          }
          const kb = bot.renderCodespacesListKeyboard(list, activeCs);
          await bot.editMessageText(
            chatId,
            loadingMsg.result.message_id,
            `<b>🖥️ Your GitHub Codespaces (${list.length})</b> [Account: <code>${escapeHtml(activeAlias)}</code>]:\nSelect a codespace to control or connect:`,
            { reply_markup: kb }
          );
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Failed to fetch Codespaces for <code>${escapeHtml(activeAlias)}</code>: ${escapeHtml(err.message)}`);
        }
        return c.text('OK');
      }

      // Command: /status
      if (text === '/status') {
        if (!activeCs) {
          await bot.sendMessage(
            chatId,
            `ℹ️ Current Account: <code>${escapeHtml(activeAlias)}</code>\nNo Codespace currently selected. Use /codespaces to pick one.`
          );
          return c.text('OK');
        }
        try {
          const cs = await gh.getCodespace(activeCs);
          const cardText = bot.renderCodespaceCard(cs, activeCs, activeAlias);
          const kb = bot.renderCodespaceKeyboard(cs, activeCs, workerOrigin, agentSecret);
          await bot.sendMessage(chatId, cardText, { reply_markup: kb });
        } catch (err: any) {
          await bot.sendMessage(chatId, `❌ Active Codespace (${escapeHtml(activeCs)}) status error: ${escapeHtml(err.message)}`);
        }
        return c.text('OK');
      }

      // Command: /agent
      if (text === '/agent') {
        const installScriptCmd = `curl -sSL "${workerOrigin}/agent/setup-sshd-web-tty.sh?chat_id=${chatId}" | bash`;
        await bot.sendMessage(
          chatId,
          `🛠️ <b>ttyd Web Terminal & Agent Installer Script:</b>\n\nRun this command inside your Codespace terminal to install ttyd Web Terminal, OpenSSH server, and public tunnel on boot:\n\n<code>${installScriptCmd}</code>`
        );
        return c.text('OK');
      }

      // Command Execution & Pure Code AI Natural Language Processing
      if (text.startsWith('/sh ') || (activeCs && !text.startsWith('/'))) {
        const rawInput = text.startsWith('/sh ') ? text.substring(4).trim() : text;

        let targetCs = activeCs;
        if (!targetCs) {
          try {
            const csList = await gh.listCodespaces();
            if (csList && csList.length > 0) {
              targetCs = csList[0].name;
              await bridge.setActiveCodespace(userId, targetCs);
            }
          } catch (e) {}
        }

        if (!targetCs) {
          await bot.sendMessage(
            chatId,
            '⚠️ No active Codespace selected. Use /codespaces to select one first.'
          );
          return c.text('OK');
        }

        // SubAgent #4: Security Sentinel Check
        const secAudit = subagents.auditSecurity(rawInput);
        if (!secAudit.safe) {
          await bot.sendMessage(chatId, `🚨 <b>SubAgent #4 [SecuritySentinel Alert]:</b>\n${escapeHtml(secAudit.reason || 'Blocked dangerous command')}`);
          return c.text('OK');
        }

        // SubAgent #5: Pure Code Natural Language Processing
        const nlpResult = subagents.processNaturalLanguage(chatId, rawInput, targetCs);

        if (!nlpResult.handled && nlpResult.command) {
          const pending = await bridge.queueCommand(targetCs, nlpResult.command, chatId);
          const pendingNotice = `<i>Waiting for execution response...</i>`;

          await bot.sendMessage(
            chatId,
            `🚀 Command sent to <code>${escapeHtml(targetCs)}</code>:\n<code>$ ${escapeHtml(nlpResult.command)}</code>\n${pendingNotice}`
          );
        } else if (nlpResult.handled) {
          await bot.sendMessage(chatId, nlpResult.message);
        }
        return c.text('OK');
      }

      // Fallback
      await bot.sendMessage(
        chatId,
        '💡 Use /codespaces to manage Codespaces, /create_cs to launch a new one, /accounts for PATs, /agents for 10 Smart Sub-Agents, or type any command to run in terminal.'
      );
    }
  } catch (err: any) {
    console.error('Webhook error:', err);
  }

  return c.text('OK');
});

// Serve Agent install / SSH Web TTY script dynamically with Cloudflare Quick Tunnel, Pinggy & Serveo multi-tunnel
app.get('/agent/setup-sshd-web-tty.sh', (c) => {
  const origin = new URL(c.req.url).origin;
  const agentSecret = getAgentSecret(c.env);
  let targetChatId = c.req.query('chat_id') || c.req.query('chatId') || '';
  if (targetChatId === 'YOUR_CHAT_ID') targetChatId = '';

  const script = `#!/bin/bash
set -e

WORKER_URL="${origin}"
AGENT_SECRET="${agentSecret}"
TARGET_CHAT_ID="${targetChatId}"
CODESPACE_NAME="\${CODESPACE_NAME:-\$HOSTNAME}"

if [ "\$TARGET_CHAT_ID" = "YOUR_CHAT_ID" ]; then
  TARGET_CHAT_ID=""
fi

AGENT_DIR="\$HOME/.codespace-telegram-agent"
mkdir -p "\$AGENT_DIR"
rm -f "\$AGENT_DIR"/*.log

echo "============================================================"
echo "🚀 Setting up OpenSSH Server, ttyd & Public Tunnel..."
echo "Codespace: \$CODESPACE_NAME"
echo "Worker URL: \$WORKER_URL"
echo "============================================================"

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

echo "📦 Checking SSHD status..."
if command -v sshd >/dev/null 2>&1; then
  echo "✅ OpenSSH Server is available."
  \$SUDO service ssh status >/dev/null 2>&1 || \$SUDO service ssh start || true
fi

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
eval "nohup \$TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > ~/.codespace-telegram-agent/ttyd.log 2>&1 &"

sleep 2

PUBLIC_TTYD_URL=""
if command -v gh >/dev/null 2>&1; then
  echo "🌐 Setting up GitHub Codespaces Native Public Port 7681..."
  gh codespace ports visibility 7681:public -c "\$CODESPACE_NAME" 2>/dev/null || true
  GH_APP_URL="https://\${CODESPACE_NAME}-7681.app.github.dev"
  HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "\$GH_APP_URL" || true)
  if [ "\$HTTP_CODE" = "200" ] || [ "\$HTTP_CODE" = "302" ] || [ "\$HTTP_CODE" = "401" ]; then
    PUBLIC_TTYD_URL="\$GH_APP_URL"
    echo "✅ GitHub Native Tunnel active: \${PUBLIC_TTYD_URL}"
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

if [ -n "\$CF_BIN" ]; then
  eval "nohup \$CF_BIN tunnel --url http://localhost:7681 > ~/.codespace-telegram-agent/cloudflared.log 2>&1 &"
fi

eval "nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > ~/.codespace-telegram-agent/pinggy.log 2>&1 &"

if [ -z "\$PUBLIC_TTYD_URL" ]; then
  for i in {1..12}; do
    CANDIDATE=""
    if [ -f ~/.codespace-telegram-agent/cloudflared.log ]; then
      CANDIDATE=\$(grep -a -oE "https://[a-zA-Z0-9.-]+\\.trycloudflare\\.com" ~/.codespace-telegram-agent/cloudflared.log | tail -n 1 || true)
    fi
    if [ -z "\$CANDIDATE" ] && [ -f ~/.codespace-telegram-agent/pinggy.log ]; then
      CANDIDATE=\$(grep -a -oE "https://[a-zA-Z0-9.-]+\\.(pinggy\\.online|pinggy\\.link)" ~/.codespace-telegram-agent/pinggy.log | tail -n 1 || true)
    fi

    if [[ "\$CANDIDATE" == https://* ]]; then
      HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "\$CANDIDATE" || true)
      if [ "\$HTTP_CODE" = "200" ] || [ "\$HTTP_CODE" = "302" ] || [ "\$HTTP_CODE" = "401" ]; then
        PUBLIC_TTYD_URL="\$CANDIDATE"
        break
      fi
    fi
    sleep 1
  done
fi

echo ""
echo "============================================================"
if [ -n "\$PUBLIC_TTYD_URL" ]; then
  echo "🌐 Live ttyd Web Terminal URL: \${PUBLIC_TTYD_URL}"
else
  echo "🖥️ ttyd server running on local port 7681 (Background agent will register tunnel URL when live)"
fi
echo "============================================================"
echo ""

echo "📥 Fetching Background Telegram Agent..."
curl -sSL "\${WORKER_URL}/agent/agent.js" -o ~/.codespace-telegram-agent/agent.js

START_SCRIPT="\$AGENT_DIR/start.sh"
cat << EOF > "\$START_SCRIPT"
#!/bin/bash
export HOME="\${HOME:-/root}"
AGENT_DIR="\\$HOME/.codespace-telegram-agent"

if pgrep -f 'node.*agent.js' > /dev/null 2>&1; then
  exit 0
fi

TTYD_BIN="ttyd"
if [ -f "\\$AGENT_DIR/ttyd" ]; then
  TTYD_BIN="\\$AGENT_DIR/ttyd"
fi

pgrep -f "ttyd" > /dev/null 2>&1 || nohup \\$TTYD_BIN --writable -p 7681 --interface 0.0.0.0 bash > "\\$AGENT_DIR/ttyd.log" 2>&1 &
[ -f "\\$AGENT_DIR/cloudflared" ] && ! pgrep -f "cloudflared" >/dev/null 2>&1 && nohup "\\$AGENT_DIR/cloudflared" tunnel --url http://localhost:7681 > "\\$AGENT_DIR/cloudflared.log" 2>&1 &
pgrep -f "ssh.*pinggy" > /dev/null 2>&1 || nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 -R 0:localhost:7681 a.pinggy.online > "\\$AGENT_DIR/pinggy.log" 2>&1 &

if [ -f "\\$AGENT_DIR/agent.js" ]; then
  nohup node "\\$AGENT_DIR/agent.js" "\${WORKER_URL}" "\${AGENT_SECRET}" "\${CODESPACE_NAME}" "\${PUBLIC_TTYD_URL}" "\${TARGET_CHAT_ID}" > "\\$AGENT_DIR/agent.log" 2>&1 &
fi
EOF
chmod +x "\$START_SCRIPT"

if ! grep -q "codespace-telegram-agent/start.sh" ~/.bashrc 2>/dev/null; then
  echo "" >> ~/.bashrc
  echo "[ -f \$START_SCRIPT ] && \$START_SCRIPT >/dev/null 2>&1 &" >> ~/.bashrc
  echo "✅ Configured auto-start in ~/.bashrc"
fi

if [ -f ~/.zshrc ] && ! grep -q "codespace-telegram-agent/start.sh" ~/.zshrc 2>/dev/null; then
  echo "" >> ~/.zshrc
  echo "[ -f \$START_SCRIPT ] && \$START_SCRIPT >/dev/null 2>&1 &" >> ~/.zshrc
  echo "✅ Configured auto-start in ~/.zshrc"
fi

if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "codespace-telegram-agent" || true; echo "@reboot \$START_SCRIPT >/dev/null 2>&1 &") | crontab - 2>/dev/null || true
  echo "✅ Configured crontab @reboot auto-start for background boots"
fi

if [ -d /etc/profile.d ]; then
  if [ -n "\$SUDO" ]; then
    \$SUDO bash -c "echo '[ -f \$START_SCRIPT ] && \$START_SCRIPT >/dev/null 2>&1 &' > /etc/profile.d/codespace-telegram-agent.sh && chmod +x /etc/profile.d/codespace-telegram-agent.sh" 2>/dev/null || true
  fi
fi

echo "🔄 Starting Telegram Bridge agent process..."
pkill -f "node.*agent.js" || true
nohup node "\$AGENT_DIR/agent.js" "\${WORKER_URL}" "\${AGENT_SECRET}" "\${CODESPACE_NAME}" "\${PUBLIC_TTYD_URL}" "\${TARGET_CHAT_ID}" > "\$AGENT_DIR/agent.log" 2>&1 &

echo "============================================================"
echo "🎉 SUCCESS! ttyd Web Terminal & Multi-Hook Auto-Boot active."
echo "📱 Telegram notification sent to your bot!"
echo "============================================================"
`;

  return c.text(script, 200, { 'Content-Type': 'text/x-shellscript' });
});

// Alias for install.sh
app.get('/agent/install.sh', (c) => {
  return app.request('/agent/setup-sshd-web-tty.sh', {}, c.env);
});

// Serve Agent JavaScript file dynamically
app.get('/agent/agent.js', (c) => {
  const origin = new URL(c.req.url).origin;
  const agentSecret = getAgentSecret(c.env);

  const agentJs = `
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const WORKER_URL = process.argv[2] || "${origin}";
const AGENT_SECRET = process.argv[3] || "${agentSecret}";
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

console.log(\`[Agent] Started for Codespace: \${CODESPACE_NAME}\`);

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
  const ghNativeUrl = \`https://\${CODESPACE_NAME}-7681.app.github.dev\`;
  if (await checkUrlHttpReachable(ghNativeUrl)) {
    return ghNativeUrl;
  }

  const logFiles = [
    { file: path.join(agentDir, 'cloudflared.log'), regex: /https:\\/\\/[a-zA-Z0-9.-]+\\.trycloudflare\\.com/g },
    { file: path.join(agentDir, 'pinggy.log'), regex: /https:\\/\\/[a-zA-Z0-9.-]+\\.(pinggy\\.online|pinggy\\.link)/g },
  ];

  for (const item of logFiles) {
    try {
      if (fs.existsSync(item.file)) {
        const content = fs.readFileSync(item.file, 'utf8');
        const matches = content.match(item.regex);
        if (matches && matches.length > 0) {
          const candidate = matches[matches.length - 1];
          if (candidate && candidate.startsWith('https://') && !candidate.includes('Binary file') && !candidate.includes('serveo.net')) {
            if (await checkUrlHttpReachable(candidate)) {
              return candidate;
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
  if (PUBLIC_TUNNEL_URL && PUBLIC_TUNNEL_URL.startsWith('https://') && !PUBLIC_TUNNEL_URL.includes('Binary file')) {
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

  console.log(\`[Agent] Sending notify-online to Worker... Tunnel URL: \${detected}\`);

  try {
    const payload = JSON.stringify({
      codespaceName: CODESPACE_NAME,
      secret: AGENT_SECRET,
      publicTunnelUrl: detected,
      chatId: TARGET_CHAT_ID || undefined
    });

    const url = new URL(\`\${WORKER_URL}/agent/notify-online\`);
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
          console.log(\`[Agent] notify-online success! URL registered: \${detected}\`);
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

async function pollCommands() {
  try {
    const url = \`\${WORKER_URL}/agent/poll?codespace_name=\${encodeURIComponent(CODESPACE_NAME)}&secret=\${encodeURIComponent(AGENT_SECRET)}\`;
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
  console.log(\`[Agent] Executing command \${cmdObj.id}: \${cmdObj.command}\`);
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
      chatId: cmdObj.chatId
    });

    const url = new URL(\`\${WORKER_URL}/agent/result\`);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      console.log(\`[Agent] Result sent for \${cmdObj.id}, status: \${res.statusCode}\`);
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
`;
  return c.text(agentJs, 200, { 'Content-Type': 'application/javascript' });
});

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: Env, ctx: any) {
    console.log('[Cron Keep-Alive] Checking Codespaces status...');
    const bridge = new BridgeManager(env);
    const gh = new GitHubCodespacesAPI(env);
    const bot = new TelegramBot(env);

    try {
      const list = await gh.listCodespaces();
      for (const cs of list) {
        const state = (cs.state || '').toLowerCase();
        const isManual = await bridge.isManuallyStopped(cs.name);

        if (isManual) {
          console.log(`[Cron Keep-Alive] Skipping ${cs.name} because user manually stopped it.`);
          continue;
        }

        if (state === 'stopped' || state === 'shutdown') {
          console.log(`[Cron Keep-Alive] Codespace ${cs.name} is ${cs.state} due to idle timeout. Attempting auto-restart...`);
          await gh.startCodespace(cs.name);
          const allowedUsers = (env.TELEGRAM_ALLOWED_USERS || '').split(',').map((u) => u.trim()).filter(Boolean);
          const lastChatId = await bridge.getLastChatId();

          const targets = new Set<number>();
          for (const uStr of allowedUsers) {
            const uId = parseInt(uStr, 10);
            if (!isNaN(uId)) targets.add(uId);
          }
          if (lastChatId) targets.add(lastChatId);

          for (const uId of targets) {
            await bot.sendMessage(uId, `🔄 <b>Auto Keep-Alive Alert:</b> Detected Codespace <code>${escapeHtml(cs.name)}</code> timed out (${escapeHtml(cs.state)}). Automatically restarting Codespace!`);
          }
        }
      }
    } catch (err: any) {
      console.error('[Cron Keep-Alive] Error:', err.message);
    }
  },
};
