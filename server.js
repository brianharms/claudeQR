const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const SessionManager = require('./session-manager');

const PORT = parseInt(process.env.MOBILTERM_PORT || '7777', 10);
const TOKEN_FILE = path.join(__dirname, '.auth-token');

// Persistent auth token
let AUTH_TOKEN;
if (fs.existsSync(TOKEN_FILE)) {
  AUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
} else {
  AUTH_TOKEN = crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN);
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const manager = new SessionManager();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──

app.get('/api/sessions', authCheck, (req, res) => {
  res.json(manager.listSessions());
});

app.get('/api/sessions/grouped', authCheck, (req, res) => {
  res.json(manager.groupedSessions());
});

app.post('/api/sessions', authCheck, (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
  try {
    const sessionName = manager.spawn(projectPath);
    res.json({ sessionName, status: 'spawned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:name', authCheck, (req, res) => {
  const { name } = req.params;
  const session = manager.getSession(name);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  manager.killSession(name);
  res.json({ killed: name });
});

app.post('/api/sessions/cleanup', authCheck, (req, res) => {
  const killed = manager.killStale();
  res.json({ killed, count: killed.length });
});

app.get('/api/projects', authCheck, (req, res) => {
  res.json(manager.listProjects());
});

// ── WebSocket — multiplexed ──

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const subscriptions = new Map(); // sessionName -> listener

  // Send current session list on connect (grouped)
  ws.send(JSON.stringify({ type: 'sessions', data: manager.listSessions(), grouped: manager.groupedSessions() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'subscribe': {
          const session = manager.getSession(msg.session);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: `Session not found: ${msg.session}` }));
            return;
          }
          if (subscriptions.has(msg.session)) return;

          const listener = (output) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'output', session: msg.session, data: output }));
            }
          };
          session.bridge.on('output', listener);
          session.bridge.subscribe();
          subscriptions.set(msg.session, listener);

          // Send last known output immediately
          if (session.bridge.lastOutput) {
            ws.send(JSON.stringify({ type: 'output', session: msg.session, data: session.bridge.lastOutput }));
          }
          break;
        }

        case 'unsubscribe': {
          const sub = subscriptions.get(msg.session);
          const session = manager.getSession(msg.session);
          if (sub && session) {
            session.bridge.removeListener('output', sub);
            session.bridge.unsubscribe();
            subscriptions.delete(msg.session);
          }
          break;
        }

        case 'input': {
          const session = manager.getSession(msg.session);
          if (session) session.bridge.sendInput(msg.data);
          break;
        }

        case 'rawkeys': {
          const session = manager.getSession(msg.session);
          if (session) session.bridge.sendRawKeys(msg.data);
          break;
        }

        case 'list': {
          ws.send(JSON.stringify({ type: 'sessions', data: manager.listSessions(), grouped: manager.groupedSessions() }));
          break;
        }

        case 'kill': {
          if (msg.session) {
            manager.killSession(msg.session);
            ws.send(JSON.stringify({ type: 'killed', session: msg.session }));
          }
          break;
        }

        case 'cleanup': {
          const killed = manager.killStale();
          ws.send(JSON.stringify({ type: 'cleaned', killed, count: killed.length }));
          break;
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    for (const [sessionName, listener] of subscriptions) {
      const session = manager.getSession(sessionName);
      if (session) {
        session.bridge.removeListener('output', listener);
        session.bridge.unsubscribe();
      }
    }
    subscriptions.clear();
  });
});

// Broadcast session list updates to all connected clients
setInterval(() => {
  const sessions = manager.listSessions();
  const grouped = manager.groupedSessions();
  const msg = JSON.stringify({ type: 'sessions', data: sessions, grouped });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}, 5000);

manager.startDiscovery(5000);

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`mobileTerm running on port ${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN}`);
  console.log(`Connect: http://${ip}:${PORT}/?token=${AUTH_TOKEN}`);
});
