const { execSync } = require('child_process');
const EventEmitter = require('events');

class TerminalBridge extends EventEmitter {
  constructor(sessionName, opts = {}) {
    super();
    this.session = sessionName;
    this.pollInterval = opts.pollInterval || 250;
    this.scrollback = opts.scrollback || 500;
    this._timer = null;
    this._lastOutput = '';
    this._subscribers = 0;
  }

  capturePane() {
    try {
      return execSync(
        `tmux capture-pane -t "${this.session}" -e -p -S -${this.scrollback}`,
        { encoding: 'utf-8', timeout: 3000 }
      );
    } catch {
      return null;
    }
  }

  start() {
    if (this._timer) return;
    // Immediate first capture
    const output = this.capturePane();
    if (output !== null) {
      this._lastOutput = output;
      this.emit('output', output);
    }
    this._timer = setInterval(() => {
      const output = this.capturePane();
      if (output !== null && output !== this._lastOutput) {
        this._lastOutput = output;
        this.emit('output', output);
      }
    }, this.pollInterval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  subscribe() {
    this._subscribers++;
    if (this._subscribers === 1) this.start();
  }

  unsubscribe() {
    this._subscribers = Math.max(0, this._subscribers - 1);
    if (this._subscribers === 0) this.stop();
  }

  sendInput(text) {
    try {
      execSync(`tmux send-keys -t "${this.session}" -l ${JSON.stringify(text)}`);
      execSync(`tmux send-keys -t "${this.session}" Enter`);
    } catch (err) {
      this.emit('error', err);
    }
  }

  sendRawKeys(keys) {
    try {
      execSync(`tmux send-keys -t "${this.session}" ${keys}`);
    } catch (err) {
      this.emit('error', err);
    }
  }

  get lastOutput() {
    return this._lastOutput;
  }

  get isActive() {
    return this._timer !== null;
  }
}

module.exports = TerminalBridge;
