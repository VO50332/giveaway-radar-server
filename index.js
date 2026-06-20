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

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessionManager.getSessionCount() }));

// Start a new WhatsApp session for a user
app.post('/session/start', async (req, res) => {
  const { userId, appId } = req.body;
  const apiKey = req.body.apiKey || process.env.BASE44_API_KEY;
  const effectiveAppId = appId || process.env.BASE44_APP_ID;
  if (!userId || !apiKey || !effectiveAppId) {
    return res.status(400).json({
      error: 'Missing credentials',
      details: {
        userId: !!userId,
        apiKey: !!apiKey,
        appId: !!effectiveAppId,
        hint: apiKey ? undefined : 'Set BASE44_API_KEY env var on Railway or pass apiKey in request body',
      }
    });
  }

  try {
    const result = await sessionManager.startSession(userId, apiKey, effectiveAppId, (event, data) => {
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

// Debug: test puppeteer/chromium availability
app.get('/debug/puppeteer', async (req, res) => {
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    await browser.close();
    res.json({ status: 'ok', message: 'Puppeteer works' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
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
