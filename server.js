const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── Config ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;

// ─── State ────────────────────────────────────────────
const clients = new Map();     // ws → { id, username, color }
let userIdCounter = 0;
const messageHistory = [];     // recent messages for new joiners
let serverStartTime = Date.now();

const COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e84393','#00cec9','#6c5ce7',
  '#fd79a8','#00b894','#fdcb6e','#74b9ff','#a29bfe'
];

// ─── HTTP Server (serves the HTML client) ─────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading chat page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ─── WebSocket Server ────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client !== excludeWs) {
      client.send(payload);
    }
  });
}

function getOnlineList() {
  return Array.from(clients.values()).map(u => ({
    id: u.id,
    username: u.username,
    color: u.color
  }));
}

function getUptime() {
  const seconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function createMessage(type, from, text, color = '#888') {
  return {
    type,            // 'message' | 'system' | 'join' | 'leave' | 'history' | 'online'
    id: Date.now() + Math.random(),
    from,
    text,
    color,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })
  };
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  userIdCounter++;
  const userColor = COLORS[userIdCounter % COLORS.length];
  const tempId = userIdCounter;
  let username = null;
  let isAlive = true;
  let joinTimeout = null;

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── First message must be a username ──
    if (!username) {
      username = String(data.username || '').trim().slice(0, 20) || `User${tempId}`;

      // Check for duplicate names
      let dupes = 0;
      Array.from(clients.values()).forEach(u => {
        if (u.username === username) dupes++;
      });
      if (dupes > 0) username += ` (${dupes + 1})`;

      clients.set(ws, { id: tempId, username, color: userColor });

      // Send user their identity
      ws.send(JSON.stringify({
        type: 'welcome',
        username,
        color: userColor,
        id: tempId
      }));

      // Send recent message history
      ws.send(JSON.stringify({
        type: 'history',
        messages: messageHistory.slice(-50)
      }));

      // Announce join
      const joinMsg = createMessage('join', 'SYSTEM', `${username} joined the chat`, '#27ae60');
      messageHistory.push(joinMsg);
      if (messageHistory.length > HISTORY_LIMIT) messageHistory.shift();

      broadcast(joinMsg);
      broadcast({ type: 'online', users: getOnlineList(), count: getOnlineList().length });

      console.log(`[+] ${username} connected (${ip}) — ${getOnlineList().length} online`);
      return;
    }

    // ── Regular messages ──
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) return;

    const msg = createMessage('message', username, text, userColor);
    messageHistory.push(msg);
    if (messageHistory.length > HISTORY_LIMIT) messageHistory.shift();

    broadcast(msg);
    console.log(`[${msg.time}] ${username}: ${text}`);
  });

  ws.on('close', () => {
    if (username && clients.has(ws)) {
      clients.delete(ws);
      const leaveMsg = createMessage('leave', 'SYSTEM', `${username} left the chat`, '#e74c3c');
      messageHistory.push(leaveMsg);
      if (messageHistory.length > HISTORY_LIMIT) messageHistory.shift();
      broadcast(leaveMsg);
      broadcast({ type: 'online', users: getOnlineList(), count: getOnlineList().length });
      console.log(`[-] ${username} disconnected — ${getOnlineList().length} online`);
    }
  });

  ws.on('error', () => {});

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (!isAlive) return ws.terminate();
    isAlive = false;
    ws.ping();
  }, 30000);
  ws.on('close', () => clearInterval(heartbeat));

  // Auto-kick if no username within 10s
  joinTimeout = setTimeout(() => {
    if (!username) ws.terminate();
  }, 10000);
  ws.on('message', () => { clearTimeout(joinTimeout); }, { once: true });
});

// ─── Start ────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     ⚡  REAL-TIME CHAT SERVER  ⚡        ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Port:     ${String(PORT).padEnd(29)}║`);
  console.log(`  ║  Status:   ONLINE${' '.repeat(24)}║`);
  console.log(`  ║  Protocol: WebSocket (ws://)${' '.repeat(11)}║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Waiting for connections...');
  console.log('');
});
