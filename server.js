const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// Serve studio console
app.use(express.static(path.join(__dirname, 'studio')));
// Serve guest app at /guest (only available locally — APK loads from assets)
app.use('/guest', express.static(path.join(__dirname, 'studio')));

const PORT = process.env.PORT || 3400;

// In-memory rooms
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.post('/api/create-room', (req, res) => {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    studioSocketId: null,
    guests: {},
    createdAt: Date.now()
  };
  console.log(`Room created: ${code}`);
  res.json({ code });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    guestCount: Object.keys(room.guests).length,
    hasStudio: !!room.studioSocketId
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

// ── Socket.io signaling ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Studio joins ──
  socket.on('studio-join', ({ code }) => {
    code = code.toUpperCase();
    if (!rooms[code]) return socket.emit('error', { msg: 'Room not found' });
    rooms[code].studioSocketId = socket.id;
    socket.join(code);
    socket.data.role = 'studio';
    socket.data.code = code;
    socket.emit('room-state', { guests: Object.values(rooms[code].guests) });
    console.log(`Studio joined room: ${code}`);
  });

  // ── Guest joins ──
  socket.on('guest-join', ({ code, name }, ack) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Room not found. Check your code.' });

    const guest = {
      id: socket.id,
      name: (name || 'Guest').trim().slice(0, 30),
      status: 'waiting',
      joinedAt: Date.now()
    };
    room.guests[socket.id] = guest;
    socket.join(code);
    socket.data.role = 'guest';
    socket.data.code = code;
    socket.data.name = guest.name;

    socket.emit('joined', { guest, code });
    if (typeof ack === 'function') ack({ ok: true });

    // Notify studio
    const studioSock = io.sockets.sockets.get(room.studioSocketId);
    if (studioSock) studioSock.emit('guest-joined', guest);

    console.log(`Guest "${guest.name}" joined room: ${code}`);
  });

  // ── WebRTC: Studio → Guest (studio sends offer after guest joins) ──
  socket.on('offer', ({ code, guestId, offer }) => {
    const guestSock = io.sockets.sockets.get(guestId);
    if (guestSock) guestSock.emit('offer', { from: socket.id, offer });
  });

  // ── WebRTC: Guest → Studio (guest sends answer) ──
  socket.on('answer', ({ code, to, answer }) => {
    const target = io.sockets.sockets.get(to);
    if (target) target.emit('answer', { from: socket.id, answer });
  });

  // ── ICE candidates ──
  socket.on('ice-candidate', ({ to, candidate }) => {
    const target = io.sockets.sockets.get(to);
    if (target) target.emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Studio control commands ──
  socket.on('control', ({ guestId, action }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || socket.data.role !== 'studio') return;
    const guest = room.guests[guestId];
    if (!guest) return;

    const newStatus = { cue: 'cued', 'on-air': 'on-air', hold: 'hold', remove: 'removed' }[action];
    if (newStatus) guest.status = newStatus;

    const guestSock = io.sockets.sockets.get(guestId);
    if (guestSock) guestSock.emit('status-change', { status: guest.status, action });

    socket.emit('guest-updated', guest);

    if (action === 'remove') {
      delete room.guests[guestId];
      if (guestSock) {
        guestSock.emit('removed');
        setTimeout(() => guestSock.disconnect(), 500);
      }
    }
  });

  // ── Talkback ──
  socket.on('talkback', ({ guestId, active }) => {
    const guestSock = io.sockets.sockets.get(guestId);
    if (guestSock) guestSock.emit('talkback', { active });
  });

  // ── Guest → Studio text message ──
  socket.on('guest-message', ({ message }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const studioSock = io.sockets.sockets.get(room.studioSocketId);
    if (studioSock) studioSock.emit('guest-message', {
      guestId: socket.id,
      name: socket.data.name,
      message: message.slice(0, 200),
      time: Date.now()
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;

    if (socket.data.role === 'studio') {
      room.studioSocketId = null;
      // Notify all guests studio disconnected
      io.to(code).emit('studio-disconnected');
      console.log(`Studio left room: ${code}`);
    } else if (socket.data.role === 'guest') {
      const guest = room.guests[socket.id];
      delete room.guests[socket.id];
      const studioSock = io.sockets.sockets.get(room.studioSocketId);
      if (studioSock && guest) studioSock.emit('guest-left', { guestId: socket.id });
      console.log(`Guest "${socket.data.name}" left room: ${code}`);
    }
  });
});

// Clean up old empty rooms every hour
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const room = rooms[code];
    if (!room.studioSocketId && Object.keys(room.guests).length === 0 && now - room.createdAt > 3600000) {
      delete rooms[code];
    }
  }
}, 3600000);

server.listen(PORT, () => {
  console.log(`\nHenolla OnAir server running on http://localhost:${PORT}`);
  console.log(`Studio Console: http://localhost:${PORT}`);
  console.log(`Guest App:      http://localhost:${PORT}/guest\n`);
});
