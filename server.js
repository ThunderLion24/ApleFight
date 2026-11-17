// ApleFight dedicated server: serves the game page and runs every room's physics authoritatively.
// Usage: npm install && npm start   (then open http://localhost:8080 and pick "Server")
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const CANNON = require('cannon-es');
const { createRoom, TICK } = require('./sim.js');

const PORT = Number(process.env.PORT) || 8080;
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/sim.js': 'sim.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = FILES[pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(500); res.end('Error'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
const rooms = new Map();   // code -> { room, sockets: Map(connId -> ws) }
let nextConn = 1;

wss.on('connection', ws => {
  const cid = nextConn++;
  let entry = null;
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!entry) {
      if (!msg || msg.t !== 'join') return;
      const code = String(msg.room || 'LOBBY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LOBBY';
      entry = rooms.get(code);
      if (!entry) { entry = { code, room: createRoom(CANNON), sockets: new Map() }; rooms.set(code, entry); console.log(`room ${code} opened`); }
      const reply = entry.room.join(cid, msg.name);
      ws.send(JSON.stringify({ ...reply, room: code }));
      if (reply.t !== 'welcome') { entry = null; ws.close(); return; }
      entry.sockets.set(cid, ws);
      return;
    }
    const reply = entry.room.message(cid, msg);
    if (reply) ws.send(JSON.stringify(reply));
  });
  ws.on('close', () => {
    if (!entry) return;
    entry.room.leave(cid);
    entry.sockets.delete(cid);
    if (!entry.sockets.size) { rooms.delete(entry.code); console.log(`room ${entry.code} closed`); }
  });
});

// fixed-rate simulation loop for every room
let last = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc = Math.min(acc + Number(now - last) / 1e9, 0.25);
  last = now;
  while (acc >= TICK) {
    acc -= TICK;
    for (const entry of rooms.values()) {
      const { net } = entry.room.step();
      if (!net) continue;
      const data = JSON.stringify(net);
      for (const ws of entry.sockets.values()) if (ws.readyState === 1 && ws.bufferedAmount < 256 * 1024) ws.send(data);
    }
  }
}, 5);

server.listen(PORT, () => console.log(`ApleFight server on http://localhost:${PORT}`));
