const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const SESSION_NAME = process.env.CLAUDEQR_SESSION || 'claude-qr';
const PORT = parseInt(process.env.CLAUDEQR_PORT || '3456', 10);
const AUTH_TOKEN = crypto.randomBytes(3).toString('hex');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function captureTmux() {
  try {
    return execSync(
      `tmux capture-pane -t ${SESSION_NAME} -p -S -200 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 }
    );
  } catch {
    return '[Waiting for terminal...]';
  }
}

function sendToTmux(text) {
  execSync(`tmux send-keys -t ${SESSION_NAME} -l ${JSON.stringify(text)}`);
  execSync(`tmux send-keys -t ${SESSION_NAME} Enter`);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Short redirect — this is what the QR code points to
app.get(`/${AUTH_TOKEN}`, (req, res) => {
  res.redirect(`/?token=${AUTH_TOKEN}`);
});

// QR code page — opened on the Mac so user can scan with phone
app.get('/qr', async (req, res) => {
  const ip = getLocalIP();
  const mobileUrl = `http://${ip}:${PORT}/${AUTH_TOKEN}`;
  const qrSvg = await QRCode.toString(mobileUrl, { type: 'svg', margin: 2 });

  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>claudeQR</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e;
    color: #eee;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .card {
    text-align: center;
    background: #16213e;
    border-radius: 20px;
    padding: 40px 50px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  h1 { font-size: 28px; margin-bottom: 8px; letter-spacing: -0.5px; }
  .subtitle { color: #8892a4; font-size: 15px; margin-bottom: 30px; }
  .qr-container {
    background: white;
    border-radius: 16px;
    padding: 20px;
    display: inline-block;
    margin-bottom: 24px;
  }
  .qr-container svg { width: 250px; height: 250px; }
  .url {
    font-family: 'SF Mono', monospace;
    font-size: 12px;
    color: #8892a4;
    word-break: break-all;
    max-width: 350px;
    margin: 0 auto;
  }
  .status { margin-top: 20px; font-size: 14px; color: #e94560; }
  .status.connected { color: #2ed573; }
</style>
</head><body>
<div class="card">
  <h1>claudeQR</h1>
  <p class="subtitle">Scan with your phone to connect</p>
  <div class="qr-container">${qrSvg}</div>
  <p class="url">${mobileUrl}</p>
  <p class="status" id="status">Waiting for phone to connect...</p>
</div>
<script>
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '?token=${AUTH_TOKEN}&watcher=true');
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'phone_connected') {
        document.getElementById('status').textContent = 'Phone connected!';
        document.getElementById('status').className = 'status connected';
      }
    } catch {}
  };
</script>
</body></html>`);
});

const watchers = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const isWatcher = url.searchParams.get('watcher') === 'true';

  if (token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (isWatcher) {
    watchers.add(ws);
    ws.on('close', () => watchers.delete(ws));
    return;
  }

  console.log('Phone connected');

  // Signal the QR pane to auto-close
  try {
    require('fs').writeFileSync('/tmp/claudeqr-connected', 'true');
  } catch {}

  for (const w of watchers) {
    try { w.send(JSON.stringify({ type: 'phone_connected' })); } catch {}
  }

  let lastOutput = '';
  const output = captureTmux();
  lastOutput = output;
  ws.send(JSON.stringify({ type: 'output', data: output }));

  const interval = setInterval(() => {
    const current = captureTmux();
    if (current !== lastOutput) {
      lastOutput = current;
      ws.send(JSON.stringify({ type: 'output', data: current }));
    }
  }, 500);

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === 'input') {
        sendToTmux(msg.data);
      }
    } catch {}
  });

  ws.on('close', () => {
    clearInterval(interval);
    console.log('Phone disconnected');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const mobileUrl = `http://${ip}:${PORT}/${AUTH_TOKEN}`;
  // Write connection info so the launcher script can read it
  const infoPath = '/tmp/claudeqr-info.json';
  const fs = require('fs');
  fs.writeFileSync(infoPath, JSON.stringify({
    mobileUrl,
    qrUrl: `http://localhost:${PORT}/qr`,
    token: AUTH_TOKEN,
    session: SESSION_NAME,
    port: PORT,
  }));

  // Pre-generate QR code ASCII art to a text file for the /qr slash command
  const qrcodeterminal = require('qrcode-terminal');
  qrcodeterminal.generate(mobileUrl, { small: true }, (code) => {
    const lines = [
      '',
      '  ╔══════════════════════════════════════════╗',
      '  ║         claudeQR — Scan to Connect       ║',
      '  ╚══════════════════════════════════════════╝',
      '',
      ...code.split('\n').map(l => '    ' + l),
      '',
      '  URL: ' + mobileUrl,
      '',
    ];
    fs.writeFileSync('/tmp/claudeqr-ascii.txt', lines.join('\n'));
  });

  console.log(`claudeQR server ready on port ${PORT}`);
});
