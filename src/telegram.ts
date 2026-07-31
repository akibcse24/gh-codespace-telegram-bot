import { Codespace, Env } from './types';

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TelegramBot {
  private token: string;
  private allowedUsers: number[];
  private allowedUsernames: string[];

  constructor(env: Env) {
    this.token = env.TELEGRAM_BOT_TOKEN;

    const usersStr = env.TELEGRAM_ALLOWED_USERS || '';
    this.allowedUsers = usersStr
      .split(',')
      .map((u: string) => parseInt(u.trim(), 10))
      .filter((u: number) => !isNaN(u));

    const usernamesStr = (env as any).TELEGRAM_ALLOWED_USERNAMES || '';
    this.allowedUsernames = usernamesStr
      .split(',')
      .map((u: string) => u.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean);
  }

  public isUserAllowed(userId: number, username?: string): boolean {
    if (this.allowedUsers.length === 0 && this.allowedUsernames.length === 0) {
      return true;
    }
    if (this.allowedUsers.includes(userId)) {
      return true;
    }
    if (username && this.allowedUsernames.includes(username.toLowerCase())) {
      return true;
    }
    return false;
  }

  public async sendMessage(chatId: number | string, text: string, options: any = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body: any = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data: any = await res.json();
      if (!data.ok) {
        console.error(`Telegram sendMessage failed for chat ${chatId}:`, data);
        if (data.description && (data.description.includes("can't parse entities") || data.description.includes('parse'))) {
          delete body.parse_mode;
          const fallbackRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return await fallbackRes.json();
        }
      }
      return data;
    } catch (err: any) {
      console.error(`Fetch exception in sendMessage for ${chatId}:`, err);
      return { ok: false, error: err.message };
    }
  }

  public async editMessageText(chatId: number | string, messageId: number, text: string, options: any = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/editMessageText`;
    const body: any = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data: any = await res.json();
      if (!data.ok) {
        console.error(`Telegram editMessageText failed for chat ${chatId}:`, data);
        if (data.description && (data.description.includes("can't parse entities") || data.description.includes('parse'))) {
          delete body.parse_mode;
          const fallbackRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return await fallbackRes.json();
        }
      }
      return data;
    } catch (err: any) {
      console.error(`Fetch exception in editMessageText:`, err);
      return { ok: false, error: err.message };
    }
  }

  public async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert: boolean = false): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert,
        }),
      });
      return await res.json();
    } catch (err) {
      return { ok: false };
    }
  }

  public renderCodespaceCard(cs: Codespace, activeCsName?: string, activeAlias: string = 'default', liveTtyUrl?: string): string {
    const isActiveTarget = activeCsName === cs.name;
    const activeBadge = isActiveTarget ? '🎯 <b>[ACTIVE TARGET FOR SHELL]</b>\n' : '';
    const stateEmoji = (cs.state || '').toLowerCase() === 'available' ? '🟢' : '🔴';

    const webUrl = cs.web_url ? `<a href="${cs.web_url}">${cs.web_url}</a>` : 'N/A';
    const lastActive = cs.last_used_at ? new Date(cs.last_used_at).toLocaleString() : 'N/A';
    const terminalLink = liveTtyUrl ? `\n🖥️ <b>Web Terminal URL:</b> ${liveTtyUrl}` : '';

    return `${activeBadge}🔑 <b>Account PAT:</b> <code>${escapeHtml(activeAlias)}</code>
<b>${escapeHtml(cs.display_name || cs.name)}</b> ${stateEmoji} (<b>${escapeHtml(cs.state)}</b>)

📦 <b>Repository:</b> <code>${escapeHtml(cs.repository.full_name)}</code>
🌿 <b>Git Branch:</b> <code>${escapeHtml(cs.git_status.ref)}</code>
💻 <b>Machine Specs:</b> ${escapeHtml(cs.machine.display_name)} (${cs.machine.cpus} vCPU, ${cs.machine.memory_in_bytes / (1024 * 1024 * 1024)}GB RAM)
📅 <b>Last Activity:</b> ${lastActive}
🌐 <b>Web Access:</b> ${webUrl}${terminalLink}`;
  }

  public renderCodespacesListKeyboard(list: Codespace[], activeCsName?: string): any {
    const buttons = list.map((cs) => {
      const isActive = cs.name === activeCsName;
      const label = `${isActive ? '🎯 ' : ''}${cs.display_name || cs.name} (${cs.state})`;
      return [{ text: label, callback_data: `get:${cs.name}` }];
    });

    buttons.push([
      { text: '➕ Create New Codespace', callback_data: 'create_prompt' },
      { text: '🔑 Switch GitHub PAT', callback_data: 'accounts' },
    ]);

    return { inline_keyboard: buttons };
  }

  public renderCreateTemplateKeyboard(): any {
    return {
      inline_keyboard: [
        [{ text: '⚡ Express.js Node App', callback_data: 'create_repo:github/codespaces-express' }],
        [{ text: '🐍 Jupyter Data Science', callback_data: 'create_repo:github/codespaces-jupyter' }],
        [{ text: '⚛️ React Web App', callback_data: 'create_repo:github/codespaces-react' }],
        [{ text: '🐧 Blank Linux Container', callback_data: 'create_repo:github/codespaces-blank' }],
        [{ text: '📋 Back to List', callback_data: 'list' }],
      ],
    };
  }

  public renderAccountsKeyboard(accounts: any[], activeAlias: string): any {
    const buttons = accounts.map((acc) => {
      const isCurrent = acc.alias === activeAlias;
      const label = `${isCurrent ? '✅ ' : ''}${acc.alias} (${acc.isDefault ? 'Default PAT' : 'Custom PAT'})`;
      return [{ text: label, callback_data: `use_account:${acc.alias}` }];
    });

    buttons.push([
      { text: '➕ Add New PAT Account', callback_data: 'add_account_info' },
      { text: '📋 Back to Codespaces', callback_data: 'list' },
    ]);

    return { inline_keyboard: buttons };
  }

  public renderCodespaceKeyboard(cs: Codespace, activeCsName: string | undefined, workerOrigin: string, agentSecret: string, liveTtyUrl?: string): any {
    const isRunning = (cs.state || '').toLowerCase() === 'available';
    const isTarget = activeCsName === cs.name;

    const redirectTtyUrl = `${workerOrigin}/tty?codespace_name=${encodeURIComponent(cs.name)}&secret=${encodeURIComponent(agentSecret)}`;
    const finalTtyUrl = liveTtyUrl || redirectTtyUrl;

    const row1 = isRunning
      ? [
          { text: '🔴 Stop Codespace', callback_data: `stop:${cs.name}` },
          { text: '🔄 Rebuild', callback_data: `rebuild:${cs.name}` },
        ]
      : [
          { text: '🟢 Start Codespace', callback_data: `start:${cs.name}` },
          { text: '🔄 Rebuild', callback_data: `rebuild:${cs.name}` },
        ];

    const row2 = [
      {
        text: isTarget ? '✅ Active Shell Target' : '🎯 Select Target for Shell',
        callback_data: `select:${cs.name}`,
      },
      {
        text: '🖥️ Open TTY Terminal',
        url: finalTtyUrl,
      },
    ];

    const row3 = [{ text: '🗑️ Delete Codespace', callback_data: `delete_prompt:${cs.name}` }];

    const row4 = [
      { text: '📋 Codespaces List', callback_data: 'list' },
      { text: '➕ Create Codespace', callback_data: 'create_prompt' },
      { text: '🔑 Switch Account', callback_data: 'accounts' },
    ];

    return {
      inline_keyboard: [row1, row2, row3, row4],
    };
  }
}
