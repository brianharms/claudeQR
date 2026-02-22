const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const TerminalBridge = require('./terminal-bridge');

const PROJECTS_DIR = path.join(process.env.HOME, 'Desktop', 'Claude Projects');
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionName -> { bridge, meta }
    this._discoveryTimer = null;
  }

  startDiscovery(intervalMs = 5000) {
    this.discover();
    this._discoveryTimer = setInterval(() => this.discover(), intervalMs);
  }

  stopDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
  }

  discover() {
    try {
      const raw = execSync(
        'tmux list-panes -a -F "#{session_name}|#{pane_pid}|#{pane_current_path}|#{session_created}|#{pane_current_command}|#{session_activity}|#{session_attached}"',
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();

      if (!raw) return;

      // Collect all panes per session for dedup
      const panesBySession = new Map(); // sessionName -> [paneData, ...]
      for (const line of raw.split('\n')) {
        const parts = line.split('|');
        if (parts.length < 7) continue;
        const [sessionName, pid, cwd, created, command, activity, attached] = parts;
        if (!sessionName) continue;

        if (!panesBySession.has(sessionName)) panesBySession.set(sessionName, []);
        panesBySession.get(sessionName).push({
          sessionName,
          pid: parseInt(pid) || 0,
          cwd: cwd || '',
          created: parseInt(created) * 1000 || Date.now(),
          command: command || '',
          lastActivity: parseInt(activity) * 1000 || Date.now(),
          attached: attached === '1',
        });
      }

      const activeSessions = new Set();

      for (const [sessionName, panes] of panesBySession) {
        activeSessions.add(sessionName);

        // Dedup: prefer the Claude pane over a bare shell pane
        const claudePane = panes.find(p => /claude/i.test(p.command));
        const bestPane = claudePane || panes[0];

        if (!this.sessions.has(sessionName)) {
          const projectName = this._extractProjectName(bestPane.cwd);
          const bridge = new TerminalBridge(sessionName);
          this.sessions.set(sessionName, {
            bridge,
            meta: {
              sessionName,
              pid: bestPane.pid,
              cwd: bestPane.cwd,
              projectName,
              createdAt: bestPane.created,
              command: bestPane.command,
              lastActivity: bestPane.lastActivity,
              attached: bestPane.attached,
              spawned: false,
            }
          });
        } else {
          const session = this.sessions.get(sessionName);
          const newProject = this._extractProjectName(bestPane.cwd);
          if (newProject !== 'unknown') {
            session.meta.cwd = bestPane.cwd || session.meta.cwd;
            session.meta.projectName = newProject;
          }
          session.meta.command = bestPane.command || session.meta.command;
          session.meta.lastActivity = bestPane.lastActivity;
          session.meta.attached = bestPane.attached;
        }
      }

      // Remove sessions that no longer exist
      for (const [name, session] of this.sessions) {
        if (!activeSessions.has(name)) {
          session.bridge.stop();
          this.sessions.delete(name);
        }
      }
    } catch {
      // tmux not running or no sessions — that's fine
    }
  }

  _extractProjectName(cwd) {
    if (!cwd) return 'unknown';
    if (cwd.startsWith(PROJECTS_DIR)) {
      const relative = cwd.slice(PROJECTS_DIR.length + 1);
      return relative.split('/')[0] || path.basename(cwd);
    }
    return path.basename(cwd);
  }

  _deriveStatus(meta) {
    const now = Date.now();
    const idleMs = now - meta.lastActivity;
    const isClaude = /claude/i.test(meta.command);

    if (idleMs > STALE_THRESHOLD_MS) return 'stale';
    if (!isClaude) return 'shell';
    if (idleMs <= 60000) return 'working';
    return 'idle';
  }

  spawn(projectPath) {
    const projectName = path.basename(projectPath);
    const suffix = Date.now().toString(36).slice(-4);
    const sessionName = `mt-${projectName}-${suffix}`;

    try {
      execSync(
        `tmux new-session -d -s "${sessionName}" -c ${JSON.stringify(projectPath)}`,
        { timeout: 5000 }
      );
      execSync(
        `tmux send-keys -t "${sessionName}" 'claude' Enter`,
        { timeout: 3000 }
      );

      const bridge = new TerminalBridge(sessionName);
      this.sessions.set(sessionName, {
        bridge,
        meta: {
          sessionName,
          pid: null,
          cwd: projectPath,
          projectName,
          createdAt: Date.now(),
          command: 'claude',
          lastActivity: Date.now(),
          attached: false,
          spawned: true,
        }
      });

      return sessionName;
    } catch (err) {
      throw new Error(`Failed to spawn session: ${err.message}`);
    }
  }

  getSession(sessionName) {
    return this.sessions.get(sessionName);
  }

  killSession(sessionName) {
    try {
      execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 3000 });
    } catch {
      // session may already be dead
    }
    const session = this.sessions.get(sessionName);
    if (session) {
      session.bridge.stop();
      this.sessions.delete(sessionName);
    }
  }

  killStale() {
    const killed = [];
    for (const [name, session] of this.sessions) {
      if (this._deriveStatus(session.meta) === 'stale') {
        killed.push(name);
        this.killSession(name);
      }
    }
    return killed;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => {
      let preview = '';
      if (s.bridge.lastOutput) {
        const lines = s.bridge.lastOutput
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);
        preview = lines[lines.length - 1] || '';
        if (preview.length > 80) preview = preview.slice(0, 80) + '...';
      }

      const status = this._deriveStatus(s.meta);

      return {
        ...s.meta,
        status,
        idleSince: s.meta.lastActivity,
        hasSubscribers: s.bridge._subscribers > 0,
        preview,
      };
    });
  }

  groupedSessions() {
    const sessions = this.listSessions();
    const groups = new Map(); // projectName -> [session, ...]

    for (const s of sessions) {
      const key = s.projectName || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    // Sort sessions within each group: working > idle > shell > stale
    const statusOrder = { working: 0, idle: 1, shell: 2, stale: 3 };
    for (const [, list] of groups) {
      list.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
    }

    // Sort groups: groups with any active (non-stale) session first
    const sortedEntries = [...groups.entries()].sort((a, b) => {
      const aHasActive = a[1].some(s => s.status !== 'stale');
      const bHasActive = b[1].some(s => s.status !== 'stale');
      if (aHasActive && !bHasActive) return -1;
      if (!aHasActive && bHasActive) return 1;
      return a[0].localeCompare(b[0]);
    });

    return sortedEntries.map(([projectName, list]) => ({
      projectName,
      sessions: list,
      staleCount: list.filter(s => s.status === 'stale').length,
      totalCount: list.length,
    }));
  }

  listProjects() {
    try {
      const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
      const activeProjects = new Set(
        this.listSessions().map(s => s.projectName)
      );

      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(PROJECTS_DIR, e.name),
          hasActiveSession: activeProjects.has(e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}

module.exports = SessionManager;
