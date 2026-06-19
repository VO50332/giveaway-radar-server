/* eslint-env node */
/* eslint-disable no-undef */
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sessionManager = require('./sessionManager');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Load credentials from environment variables
const API_KEY = process.env.BASE44_API_KEY;
const APP_ID = process.env.BASE44_APP_ID;

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessionManager.getSessionCount() }));

// Start a new WhatsApp session
app.post('/session/start', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!API_KEY || !APP_ID) return res.status(500).json({ error: 'Server not configured' });

  try {
    const result = await sessionManager.startSession(userId, API_KEY, APP_ID, (event, data) => {
      io.to(`user:${userId}`).emit(event, data);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sessionManager = require('./sessionManager');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessionManager.getSessionCount() }));

// Start a new WhatsApp session for a user
app.post('/session/start', async (req, res) => {
  const { userId, apiKey, appId } = req.body;
  if (!userId || !apiKey || !appId) return res.status(400).json({ error: 'userId, apiKey, appId required' });

  try {
    const result = await sessionManager.startSession(userId, apiKey, appId, (event, data) => {
      io.to(`user:${userId}`).emit(event, data);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect a session
app.post('/session/disconnect', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await sessionManager.disconnectSession(userId);
  res.json({ success: true });
});

// Get session status
app.get('/session/status/:userId', (req, res) => {
  const status = sessionManager.getStatus(req.params.userId);
  res.json(status);
});

// WebSocket — user joins their room to receive QR/status updates
io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(`user:${userId}`);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`GiveAway Radar server running on port ${PORT}`);
});