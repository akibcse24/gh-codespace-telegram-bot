import { CommandResult, Env, GitHubAccount, PendingCommand } from './types';

const WORKER_CACHE_DOMAIN = 'https://gh-codespace-telegram-bot.mm-adnanakib.workers.dev';

// Global cross-isolate fallback state
const localState = {
  activeCodespaces: new Map<number, string>(), // userId -> codespaceName
  accounts: new Map<number, GitHubAccount[]>(), // userId -> accounts
  activeAccount: new Map<number, string>(), // userId -> active alias
  pendingCommands: new Map<string, PendingCommand[]>(), // codespaceName -> PendingCommand[]
  commandResults: new Map<string, CommandResult>(), // commandId -> CommandResult
  manuallyStopped: new Set<string>(), // codespaceName -> set of manually stopped codespaces
  ttydUrls: new Map<string, string>(), // codespaceName -> ttyd public tunnel url
  lastChatId: undefined as number | undefined,
  allChatIds: new Set<number>(),
  globalActiveCs: undefined as string | undefined,
  globalAccounts: [] as GitHubAccount[],
  globalActiveAlias: undefined as string | undefined,
};

// Helper for Cloudflare Edge Cache API persistence across Worker isolates
async function cachePut(key: string, data: any): Promise<void> {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const url = `${WORKER_CACHE_DOMAIN}/cache/state/${encodeURIComponent(key)}`;
      const res = new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=31536000' },
      });
      await caches.default.put(url, res);
    }
  } catch (e) {
    console.error('cachePut error:', e);
  }
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const url = `${WORKER_CACHE_DOMAIN}/cache/state/${encodeURIComponent(key)}`;
      const res = await caches.default.match(url);
      if (res) {
        return (await res.json()) as T;
      }
    }
  } catch (e) {
    console.error('cacheGet error:', e);
  }
  return undefined;
}

export class BridgeManager {
  private kv?: KVNamespace;
  private defaultPat: string;

  constructor(env: Env) {
    this.kv = env.BOT_KV;
    this.defaultPat = env.GITHUB_PAT || '';
  }

  // Save/Get Last Chat ID for Notifications
  public async setLastChatId(chatId: number): Promise<void> {
    localState.lastChatId = chatId;
    localState.allChatIds.add(chatId);
    await cachePut('last_chat_id', chatId);
    await cachePut('all_chat_ids', Array.from(localState.allChatIds));

    if (this.kv) {
      await this.kv.put('last_chat_id', chatId.toString());
      try {
        const existing = await this.kv.get('all_chat_ids');
        const list: number[] = existing ? JSON.parse(existing) : [];
        if (!list.includes(chatId)) {
          list.push(chatId);
          await this.kv.put('all_chat_ids', JSON.stringify(list));
        }
      } catch (e) {}
    }
  }

  public async getLastChatId(): Promise<number | undefined> {
    if (this.kv) {
      const val = await this.kv.get('last_chat_id');
      if (val) return parseInt(val, 10);
    }
    if (localState.lastChatId) return localState.lastChatId;
    return await cacheGet<number>('last_chat_id');
  }

  public async getChatIds(): Promise<number[]> {
    const list = new Set<number>();
    if (localState.lastChatId) list.add(localState.lastChatId);
    for (const id of localState.allChatIds) list.add(id);

    const cachedIds = await cacheGet<number[]>('all_chat_ids');
    if (cachedIds) {
      for (const id of cachedIds) list.add(id);
    }

    if (this.kv) {
      const val = await this.kv.get('last_chat_id');
      if (val) list.add(parseInt(val, 10));

      const str = await this.kv.get('all_chat_ids');
      if (str) {
        try {
          const arr: number[] = JSON.parse(str);
          for (const id of arr) list.add(id);
        } catch (e) {}
      }
    }
    return Array.from(list);
  }

  // Active Codespace per User
  public async getActiveCodespace(userId: number): Promise<string | undefined> {
    if (this.kv) {
      const val = await this.kv.get(`active_cs:${userId}`);
      if (val) return val;
    }
    let found = localState.activeCodespaces.get(userId);
    if (!found) {
      found = await cacheGet<string>(`active_cs:${userId}`);
      if (found) localState.activeCodespaces.set(userId, found);
    }
    return found || localState.globalActiveCs;
  }

  public async setActiveCodespace(userId: number, codespaceName: string): Promise<void> {
    localState.activeCodespaces.set(userId, codespaceName);
    localState.globalActiveCs = codespaceName;
    await cachePut(`active_cs:${userId}`, codespaceName);

    if (this.kv) {
      await this.kv.put(`active_cs:${userId}`, codespaceName);
    }
  }

  // Store/Get ttyd public tunnel URL
  public async setTtydUrl(codespaceName: string, url: string): Promise<void> {
    localState.ttydUrls.set(codespaceName, url);
    localState.ttydUrls.set('__global__', url);
    await cachePut(`ttyd_url:${codespaceName}`, url);
    await cachePut('ttyd_url:__global__', url);

    if (this.kv) {
      await this.kv.put(`ttyd_url:${codespaceName}`, url, { expirationTtl: 86400 });
      await this.kv.put('ttyd_url:__global__', url, { expirationTtl: 86400 });
    }
  }

  public async getTtydUrl(codespaceName: string): Promise<string | undefined> {
    if (this.kv) {
      const val = await this.kv.get(`ttyd_url:${codespaceName}`);
      if (val) return val;
      const globalVal = await this.kv.get('ttyd_url:__global__');
      if (globalVal) return globalVal;
    }
    let found = localState.ttydUrls.get(codespaceName);
    if (!found) {
      found = await cacheGet<string>(`ttyd_url:${codespaceName}`);
    }
    if (!found) {
      found = localState.ttydUrls.get('__global__');
    }
    if (!found) {
      found = await cacheGet<string>('ttyd_url:__global__');
    }
    return found;
  }

  // Manual Stop Flag
  public async setManualStop(codespaceName: string, isStopped: boolean): Promise<void> {
    if (isStopped) {
      localState.manuallyStopped.add(codespaceName);
      await cachePut(`manual_stop:${codespaceName}`, true);
    } else {
      localState.manuallyStopped.delete(codespaceName);
      await cachePut(`manual_stop:${codespaceName}`, false);
    }

    if (this.kv) {
      if (isStopped) {
        await this.kv.put(`manual_stop:${codespaceName}`, 'true');
      } else {
        await this.kv.delete(`manual_stop:${codespaceName}`);
      }
    }
  }

  public async isManuallyStopped(codespaceName: string): Promise<boolean> {
    if (this.kv) {
      const val = await this.kv.get(`manual_stop:${codespaceName}`);
      if (val !== null) return val === 'true';
    }
    if (localState.manuallyStopped.has(codespaceName)) return true;
    const cached = await cacheGet<boolean>(`manual_stop:${codespaceName}`);
    return cached === true;
  }

  // Multi-Account Management
  public async getAccounts(userId: number): Promise<GitHubAccount[]> {
    let accounts: GitHubAccount[] = [];

    if (this.kv) {
      const str = await this.kv.get(`user_accounts:${userId}`);
      if (str) accounts = JSON.parse(str);
    } else {
      accounts = localState.accounts.get(userId) || [];
      if (accounts.length === 0) {
        const cached = await cacheGet<GitHubAccount[]>(`user_accounts:${userId}`);
        if (cached && Array.isArray(cached) && cached.length > 0) {
          accounts = cached;
          localState.accounts.set(userId, accounts);
        } else if (localState.globalAccounts.length > 0) {
          accounts = localState.globalAccounts;
        }
      }
    }

    const hasRealDefaultPat = this.defaultPat && !this.defaultPat.includes('YOUR_GITHUB_PAT');
    if (hasRealDefaultPat && !accounts.some((a) => a.alias === 'default')) {
      accounts.unshift({
        alias: 'default',
        pat: this.defaultPat,
        isDefault: true,
      });
    }

    return accounts;
  }

  public async getActiveAccount(userId: number): Promise<GitHubAccount | undefined> {
    const accounts = await this.getAccounts(userId);
    if (accounts.length === 0) return undefined;

    let activeAlias: string | undefined;
    if (this.kv) {
      activeAlias = (await this.kv.get(`active_acc:${userId}`)) || undefined;
    } else {
      activeAlias = localState.activeAccount.get(userId);
      if (!activeAlias) {
        activeAlias = await cacheGet<string>(`active_acc:${userId}`);
        if (activeAlias) localState.activeAccount.set(userId, activeAlias);
      }
      if (!activeAlias) {
        activeAlias = localState.globalActiveAlias;
      }
    }

    const found = accounts.find((a) => a.alias === activeAlias);
    const validAccounts = accounts.filter((a) => a.pat && !a.pat.includes('YOUR_GITHUB_PAT'));
    return found || validAccounts[0] || accounts[accounts.length - 1] || accounts[0];
  }

  public async setActiveAccount(userId: number, alias: string): Promise<boolean> {
    const accounts = await this.getAccounts(userId);
    const exists = accounts.some((a) => a.alias === alias);
    if (!exists) return false;

    localState.activeAccount.set(userId, alias);
    localState.globalActiveAlias = alias;
    await cachePut(`active_acc:${userId}`, alias);

    if (this.kv) {
      await this.kv.put(`active_acc:${userId}`, alias);
    }
    return true;
  }

  public async addAccount(userId: number, alias: string, pat: string): Promise<void> {
    const accounts = await this.getAccounts(userId);
    const existingIdx = accounts.findIndex((a) => a.alias === alias);
    if (existingIdx >= 0) {
      accounts[existingIdx] = { alias, pat };
    } else {
      accounts.push({ alias, pat });
    }

    const customAccounts = accounts.filter((a) => !a.isDefault);

    localState.accounts.set(userId, customAccounts);
    localState.globalAccounts = customAccounts;
    await cachePut(`user_accounts:${userId}`, customAccounts);

    if (this.kv) {
      await this.kv.put(`user_accounts:${userId}`, JSON.stringify(customAccounts));
    }

    await this.setActiveAccount(userId, alias);
  }

  public async removeAccount(userId: number, alias: string): Promise<boolean> {
    const accounts = await this.getAccounts(userId);
    const filtered = accounts.filter((a) => a.alias !== alias && !a.isDefault);

    localState.accounts.set(userId, filtered);
    localState.globalAccounts = filtered;
    await cachePut(`user_accounts:${userId}`, filtered);

    if (this.kv) {
      await this.kv.put(`user_accounts:${userId}`, JSON.stringify(filtered));
    }

    const active = await this.getActiveAccount(userId);
    if (active?.alias === alias) {
      await this.setActiveAccount(userId, 'default');
    }

    return true;
  }

  // Queue Shell Command
  public async queueCommand(codespaceName: string, command: string, chatId?: number): Promise<PendingCommand> {
    const cmdObj: PendingCommand = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      command,
      timestamp: Date.now(),
      codespaceName,
      chatId,
    };

    if (this.kv) {
      const key = `pending:${codespaceName}`;
      const existingStr = await this.kv.get(key);
      const queue: PendingCommand[] = existingStr ? JSON.parse(existingStr) : [];
      queue.push(cmdObj);
      await this.kv.put(key, JSON.stringify(queue), { expirationTtl: 300 });
      await this.kv.put('pending:global', JSON.stringify(queue), { expirationTtl: 300 });
    } else {
      const queue = localState.pendingCommands.get(codespaceName) || [];
      queue.push(cmdObj);
      localState.pendingCommands.set(codespaceName, queue);

      const globalQueue = localState.pendingCommands.get('__global__') || [];
      globalQueue.push(cmdObj);
      localState.pendingCommands.set('__global__', globalQueue);

      try {
        if (typeof caches !== 'undefined' && caches.default) {
          const cacheUrl = `${WORKER_CACHE_DOMAIN}/pending-cmds/${encodeURIComponent(codespaceName)}`;
          const globalCacheUrl = `${WORKER_CACHE_DOMAIN}/pending-cmds/__global__`;
          const res = new Response(JSON.stringify(queue), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=300' },
          });
          await caches.default.put(cacheUrl, res.clone());
          await caches.default.put(globalCacheUrl, res);
        }
      } catch (e) {
        console.error('Cache API put error:', e);
      }
    }

    return cmdObj;
  }

  // Poll Commands
  public async popPendingCommands(codespaceName: string): Promise<PendingCommand[]> {
    let results: PendingCommand[] = [];

    if (this.kv) {
      const key = `pending:${codespaceName}`;
      const existingStr = await this.kv.get(key);
      if (existingStr) {
        await this.kv.delete(key);
        await this.kv.delete('pending:global');
        return JSON.parse(existingStr);
      }
      const globalStr = await this.kv.get('pending:global');
      if (globalStr) {
        await this.kv.delete('pending:global');
        return JSON.parse(globalStr);
      }
      return [];
    }

    const queue = localState.pendingCommands.get(codespaceName) || [];
    if (queue.length > 0) {
      localState.pendingCommands.set(codespaceName, []);
      localState.pendingCommands.set('__global__', []);
      results = queue;
    } else {
      const globalQueue = localState.pendingCommands.get('__global__') || [];
      if (globalQueue.length > 0) {
        localState.pendingCommands.set('__global__', []);
        results = globalQueue;
      }
    }

    if (results.length === 0 && typeof caches !== 'undefined' && caches.default) {
      try {
        const cacheUrl = `${WORKER_CACHE_DOMAIN}/pending-cmds/${encodeURIComponent(codespaceName)}`;
        const globalCacheUrl = `${WORKER_CACHE_DOMAIN}/pending-cmds/__global__`;

        let cachedRes = await caches.default.match(cacheUrl);
        if (!cachedRes) {
          cachedRes = await caches.default.match(globalCacheUrl);
        }

        if (cachedRes) {
          results = await cachedRes.json();
          await caches.default.delete(cacheUrl);
          await caches.default.delete(globalCacheUrl);
        }
      } catch (e) {
        console.error('Cache API match error:', e);
      }
    }

    return results;
  }

  // Store Result
  public async saveCommandResult(result: CommandResult): Promise<void> {
    localState.commandResults.set(result.id, result);
    await cachePut(`result:${result.id}`, result);

    if (this.kv) {
      await this.kv.put(`result:${result.id}`, JSON.stringify(result), { expirationTtl: 600 });
    }
  }

  // Fetch Result
  public async getCommandResult(cmdId: string): Promise<CommandResult | undefined> {
    if (this.kv) {
      const str = await this.kv.get(`result:${cmdId}`);
      if (str) return JSON.parse(str);
    }
    let found = localState.commandResults.get(cmdId);
    if (!found) {
      found = await cacheGet<CommandResult>(`result:${cmdId}`);
    }
    return found;
  }
}
