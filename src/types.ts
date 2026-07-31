export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USERS?: string;
  TELEGRAM_ALLOWED_USERNAMES?: string;
  GITHUB_PAT: string;
  AGENT_SECRET: string;
  BOT_KV?: KVNamespace;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
      };
    };
    data?: string;
  };
}

export interface CodespaceMachine {
  name: string;
  display_name: string;
  cpus: number;
  memory_in_bytes: number;
}

export interface CodespaceRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
}

export interface Codespace {
  id: number;
  name: string;
  display_name?: string;
  state: string; // 'Available', 'Shutdown', 'Starting', etc.
  web_url: string;
  machines_url: string;
  start_url: string;
  stop_url: string;
  created_at: string;
  last_used_at: string;
  repository: CodespaceRepository;
  machine: CodespaceMachine;
  git_status: {
    ahead: number;
    behind: number;
    has_uncommitted_changes: boolean;
    has_unpushed_changes: boolean;
    ref: string;
    sha: string;
  };
}

export interface GitHubAccount {
  alias: string;
  pat: string;
  isDefault?: boolean;
}

export interface PendingCommand {
  id: string;
  command: string;
  timestamp: number;
  codespaceName: string;
  chatId?: number;
}

export interface CommandResult {
  id: string;
  command?: string;
  codespaceName: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  chatId?: number;
}
