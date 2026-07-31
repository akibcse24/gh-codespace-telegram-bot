import { Codespace, Env } from './types';

export class GitHubCodespacesAPI {
  private token: string;

  constructor(env: Env, customPat?: string) {
    this.token = customPat || env.GITHUB_PAT || '';
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.token) {
      throw new Error('GitHub PAT is missing. Add an account using /add_account or set GITHUB_PAT secret.');
    }

    const url = `https://api.github.com${path}`;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': 'Cloudflare-Worker-Telegram-Bot',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API Error (${response.status}): ${errorText}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  public async getAuthenticatedUser(): Promise<{ login: string; id: number; name: string }> {
    return this.request<{ login: string; id: number; name: string }>('/user');
  }

  public async listCodespaces(): Promise<Codespace[]> {
    const res = await this.request<{ codespaces: Codespace[] }>('/user/codespaces');
    return res.codespaces || [];
  }

  public async getCodespace(name: string): Promise<Codespace> {
    return this.request<Codespace>(`/user/codespaces/${name}`);
  }

  public async createCodespace(repoFullName: string, ref: string = 'main'): Promise<Codespace> {
    return this.request<Codespace>(`/repos/${repoFullName}/codespaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
  }

  public async startCodespace(name: string): Promise<Codespace> {
    return this.request<Codespace>(`/user/codespaces/${name}/start`, { method: 'POST' });
  }

  public async stopCodespace(name: string): Promise<Codespace> {
    return this.request<Codespace>(`/user/codespaces/${name}/stop`, { method: 'POST' });
  }

  public async rebuildCodespace(name: string): Promise<Codespace> {
    return this.request<Codespace>(`/user/codespaces/${name}/rebuild`, { method: 'POST' });
  }

  public async deleteCodespace(name: string): Promise<void> {
    await this.request<void>(`/user/codespaces/${name}`, { method: 'DELETE' });
  }
}
