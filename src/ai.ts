/**
 * Pure Code Smart AI Engine & NLP Command Interpreter for Cloudflare Worker
 * Built with zero external LLM API dependencies — 100% pure TypeScript logic.
 */

export interface IntentResult {
  intent: string;
  confidence: number;
  suggestedCommand?: string;
  explanation: string;
  category: 'system' | 'git' | 'process' | 'network' | 'files' | 'security' | 'codespace';
}

export class PureCodeAI {
  /**
   * Parse natural language text from Telegram user into exact terminal commands & intents
   */
  public static parseIntent(text: string): IntentResult {
    const raw = text.trim();
    const lower = raw.toLowerCase();

    // 1. Git operations
    if (/\b(git status|changes|what changed|git info)\b/.test(lower)) {
      return {
        intent: 'GIT_STATUS',
        confidence: 0.95,
        suggestedCommand: 'git status -s && git branch -vv',
        explanation: 'Checks git status and active branch info.',
        category: 'git',
      };
    }
    if (/\b(git log|recent commits|commit history|commits)\b/.test(lower)) {
      return {
        intent: 'GIT_LOG',
        confidence: 0.95,
        suggestedCommand: 'git log -n 5 --oneline --graph --decorate',
        explanation: 'Shows recent 5 git commits.',
        category: 'git',
      };
    }
    if (/\b(pull|git pull|update repo|fetch latest)\b/.test(lower)) {
      return {
        intent: 'GIT_PULL',
        confidence: 0.92,
        suggestedCommand: 'git pull origin $(git rev-parse --abbrev-ref HEAD)',
        explanation: 'Pulls latest code from remote repository.',
        category: 'git',
      };
    }

    // 2. System Resource & Health
    if (/\b(ram|memory|free ram|mem info|ram usage)\b/.test(lower)) {
      return {
        intent: 'SYS_MEMORY',
        confidence: 0.95,
        suggestedCommand: 'free -h && vmstat 1 2',
        explanation: 'Checks RAM usage and memory stats.',
        category: 'system',
      };
    }
    if (/\b(cpu|cpu usage|load|processor|cores)\b/.test(lower)) {
      return {
        intent: 'SYS_CPU',
        confidence: 0.95,
        suggestedCommand: 'lscpu | grep "Model name\\|CPU(s):" ; uptime',
        explanation: 'Shows CPU specs and current load average.',
        category: 'system',
      };
    }
    if (/\b(disk|space|storage|df|free space)\b/.test(lower)) {
      return {
        intent: 'SYS_DISK',
        confidence: 0.95,
        suggestedCommand: 'df -h /workspaces /',
        explanation: 'Displays free disk space on root and workspace partitions.',
        category: 'system',
      };
    }

    // 3. Process Management
    if (/\b(running processes|ps|top processes|what is running|process list)\b/.test(lower)) {
      return {
        intent: 'PROC_LIST',
        confidence: 0.92,
        suggestedCommand: 'ps aux --sort=-%cpu | head -n 10',
        explanation: 'Lists top 10 processes sorted by CPU utilization.',
        category: 'process',
      };
    }
    if (/\b(node processes|python processes|background jobs)\b/.test(lower)) {
      return {
        intent: 'PROC_SPECIFIC',
        confidence: 0.90,
        suggestedCommand: 'pgrep -fl "node|python|bash|agent"',
        explanation: 'Lists active Node.js, Python, and Agent background jobs.',
        category: 'process',
      };
    }
    if (lower.startsWith('kill ') || lower.startsWith('stop process ')) {
      const target = raw.replace(/^(kill|stop process)\s+/i, '').trim();
      return {
        intent: 'PROC_KILL',
        confidence: 0.90,
        suggestedCommand: `pkill -f "${target}" || killall "${target}"`,
        explanation: `Terminates processes matching: ${target}`,
        category: 'process',
      };
    }

    // 4. Network & Open Ports
    if (/\b(open ports|listening ports|netstat|ports|services)\b/.test(lower)) {
      return {
        intent: 'NET_PORTS',
        confidence: 0.95,
        suggestedCommand: 'ss -tulpn || netstat -tulpn || lsof -i -P -n | grep LISTEN',
        explanation: 'Scans all active listening network ports.',
        category: 'network',
      };
    }
    if (/\b(my ip|public ip|ip address|network info)\b/.test(lower)) {
      return {
        intent: 'NET_IP',
        confidence: 0.95,
        suggestedCommand: 'curl -s https://ifconfig.me && echo "" && ip a',
        explanation: 'Fetches public IP address and local network interfaces.',
        category: 'network',
      };
    }

    // 5. File System & Search
    if (/\b(find large files|big files|largest files)\b/.test(lower)) {
      return {
        intent: 'FILE_LARGE',
        confidence: 0.92,
        suggestedCommand: 'find . -maxdepth 4 -type f -exec du -h {} + | sort -rh | head -n 15',
        explanation: 'Finds top 15 largest files in current project.',
        category: 'files',
      };
    }
    if (/\b(node version|python version|installed tools|tool versions)\b/.test(lower)) {
      return {
        intent: 'ENV_VERSIONS',
        confidence: 0.95,
        suggestedCommand: 'node -v 2>/dev/null; python3 --version 2>/dev/null; git --version; docker --version 2>/dev/null',
        explanation: 'Checks installed versions of Node, Python, Git, and Docker.',
        category: 'system',
      };
    }

    // Default Fallback
    return {
      intent: 'GENERIC_SHELL',
      confidence: 0.70,
      suggestedCommand: raw,
      explanation: `Executing raw shell command: ${raw}`,
      category: 'system',
    };
  }

  /**
   * Pure Code Security Audit Guard
   * Prevents destructive or dangerous operations (rm -rf /, dd, mkfs, format, fork bombs)
   */
  public static auditCommandSecurity(cmd: string): { safe: boolean; reason?: string } {
    const dangerousPatterns = [
      /rm\s+(-[rRfF]+\s+)?\/\s*$/,
      /rm\s+(-[rRfF]+\s+)?\/\*/,
      /mkfs/,
      /dd\s+if=/,
      />\s*\/dev\/sd/,
      /:()\s*{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/, // Fork bomb
      /chmod\s+(-R\s+)?777\s+\/$/,
      /shutdown\s+-h/,
      /reboot\s+--force/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(cmd)) {
        return {
          safe: false,
          reason: `Security Sentinel: Dangerous command pattern detected (${pattern.source}). Command blocked for safety.`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Diagnostic Error Log Analyzer (Pure Regex Stack Trace Parser)
   */
  public static analyzeLogErrors(logText: string): string[] {
    const insights: string[] = [];

    if (/EADDRINUSE/i.test(logText)) {
      insights.push('⚠️ <b>Port Conflict Detected (EADDRINUSE):</b> A process is already using the port. Run <code>pkill -f node</code> or <code>lsof -i :PORT</code> to free it.');
    }
    if (/ENOENT/i.test(logText) || /Cannot find module/i.test(logText)) {
      insights.push('📦 <b>Missing Module/File:</b> Dependencies missing. Try running <code>npm install</code> or <code>pip install -r requirements.txt</code>.');
    }
    if (/Permission denied/i.test(logText) || /EACCES/i.test(logText)) {
      insights.push('🔒 <b>Permission Denied (EACCES):</b> File or port permission restricted. Try running with <code>chmod +x</code> or adjusting file ownership.');
    }
    if (/OutOfMemory|JavaScript heap out of memory/i.test(logText)) {
      insights.push('💥 <b>Out of Memory Error:</b> Node.js process ran out of heap RAM. Set <code>NODE_OPTIONS=--max-old-space-size=4096</code>.');
    }

    return insights;
  }
}
