/**
 * 10 Specialized Pure-Code Autonomous Sub-Agents for Cloudflare Worker & Codespaces
 */

import { PureCodeAI } from './ai';
import { BridgeManager } from './bridge';
import { GitHubCodespacesAPI } from './github';
import { TelegramBot } from './telegram';
import { TTYDWorkerTunnel } from './tty';
import { Codespace, Env } from './types';

export class SubAgentRegistry {
  private env: Env;
  private bridge: BridgeManager;
  private bot: TelegramBot;

  constructor(env: Env) {
    this.env = env;
    this.bridge = new BridgeManager(env);
    this.bot = new TelegramBot(env);
  }

  // 1. System Health Agent
  public async runSystemHealthAgent(userId: number, codespaceName: string): Promise<string> {
    const cmd = 'free -h && df -h /workspaces && uptime';
    const pending = await this.bridge.queueCommand(codespaceName, cmd);
    TTYDWorkerTunnel.sendCommandViaWebSocket(codespaceName, pending, userId);
    return `🏥 <b>SubAgent #1 [SystemHealthAgent]:</b> Dispatched memory, disk, and CPU load check to <code>${codespaceName}</code>.`;
  }

  // 2. Keep-Alive Guardian Agent
  public async runKeepAliveGuardianAgent(cs: Codespace): Promise<{ actionTaken: boolean; report: string }> {
    const isManual = await this.bridge.isManuallyStopped(cs.name);
    const state = (cs.state || '').toLowerCase();

    if (isManual) {
      return {
        actionTaken: false,
        report: `🛡️ <b>SubAgent #2 [KeepAliveGuardian]:</b> Skipped <code>${cs.name}</code> (Manually stopped by user lock).`,
      };
    }

    if (state === 'stopped' || state === 'shutdown') {
      const gh = new GitHubCodespacesAPI(this.env);
      await gh.startCodespace(cs.name);
      return {
        actionTaken: true,
        report: `🛡️ <b>SubAgent #2 [KeepAliveGuardian]:</b> Detected idle timeout (${cs.state}) on <code>${cs.name}</code>. Auto-restarted Codespace container!`,
      };
    }

    return {
      actionTaken: false,
      report: `🛡️ <b>SubAgent #2 [KeepAliveGuardian]:</b> Codespace <code>${cs.name}</code> is active (${cs.state}). No action needed.`,
    };
  }

  // 3. Git Workflow Agent
  public async runGitWorkflowAgent(userId: number, codespaceName: string): Promise<string> {
    const cmd = 'git status -s && git log -n 3 --oneline';
    const pending = await this.bridge.queueCommand(codespaceName, cmd);
    TTYDWorkerTunnel.sendCommandViaWebSocket(codespaceName, pending, userId);
    return `🌿 <b>SubAgent #3 [GitWorkflowAgent]:</b> Inspection dispatched for repository branch status & recent commits.`;
  }

  // 4. Security Sentinel Agent
  public auditSecurity(command: string): { safe: boolean; reason?: string } {
    return PureCodeAI.auditCommandSecurity(command);
  }

  // 5. Terminal NLP Interpreter Agent
  public processNaturalLanguage(userId: number, text: string, codespaceName?: string): { handled: boolean; message: string; command?: string } {
    const parsed = PureCodeAI.parseIntent(text);
    if (parsed.intent !== 'GENERIC_SHELL' && parsed.suggestedCommand && codespaceName) {
      this.bridge.queueCommand(codespaceName, parsed.suggestedCommand).then((pending) => {
        TTYDWorkerTunnel.sendCommandViaWebSocket(codespaceName, pending, userId);
      });
      return {
        handled: true,
        command: parsed.suggestedCommand,
        message: `🤖 <b>SubAgent #5 [NLP Interpreter]:</b> Recognized Intent <b>${parsed.intent}</b> (${Math.round(parsed.confidence * 100)}% confidence).
💡 <i>${parsed.explanation}</i>

🚀 <b>Executing:</b> <code>${parsed.suggestedCommand}</code>`,
      };
    }
    return {
      handled: false,
      message: `Executing raw shell command: <code>${text}</code>`,
      command: text,
    };
  }

  // 6. Process Manager Agent
  public async runProcessManagerAgent(userId: number, codespaceName: string): Promise<string> {
    const cmd = 'ps aux --sort=-%cpu | head -n 12';
    const pending = await this.bridge.queueCommand(codespaceName, cmd);
    TTYDWorkerTunnel.sendCommandViaWebSocket(codespaceName, pending, userId);
    return `⚡ <b>SubAgent #6 [ProcessManager]:</b> Inspecting active processes by CPU usage on <code>${codespaceName}</code>.`;
  }

  // 7. Network Port Scanner Agent
  public async runPortScannerAgent(userId: number, codespaceName: string): Promise<string> {
    const cmd = 'ss -tulpn || netstat -tulpn || lsof -i -P -n | grep LISTEN';
    const pending = await this.bridge.queueCommand(codespaceName, cmd);
    TTYDWorkerTunnel.sendCommandViaWebSocket(codespaceName, pending, userId);
    return `🌐 <b>SubAgent #7 [NetworkPortScanner]:</b> Scanning listening network ports and active web servers on <code>${codespaceName}</code>.`;
  }

  // 8. Log Diagnostic Agent
  public analyzeLogOutput(rawLog: string): string {
    const insights = PureCodeAI.analyzeLogErrors(rawLog);
    if (insights.length === 0) return '';
    return `\n🔍 <b>SubAgent #8 [LogDiagnosticAgent] Diagnostics:</b>\n${insights.join('\n')}`;
  }

  // 9. Multi-Account Broker Agent
  public async runMultiAccountBroker(userId: number): Promise<string> {
    const accounts = await this.bridge.getAccounts(userId);
    const active = await this.bridge.getActiveAccount(userId);
    return `🔑 <b>SubAgent #9 [MultiAccountBroker]:</b> Managing ${accounts.length} registered GitHub PAT token(s). Currently active: <code>${active?.alias || 'default'}</code>.`;
  }

  // 10. Auto Task Scheduler Agent
  public async runAutoSchedulerHealthCheck(): Promise<string[]> {
    const gh = new GitHubCodespacesAPI(this.env);
    const logs: string[] = [];
    try {
      const list = await gh.listCodespaces();
      for (const cs of list) {
        const res = await this.runKeepAliveGuardianAgent(cs);
        logs.push(res.report);
      }
    } catch (e: any) {
      logs.push(`Error in AutoScheduler: ${e.message}`);
    }
    return logs;
  }
}
