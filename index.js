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
  const { userId } = req.body;
  const effectiveAppId = req.body.appId || process.env.BASE44_APP_ID;
  if (!userId || !effectiveAppId) {
    return res.status(400).json({
      error: 'Missing credentials',
      details: { userId: !!userId, appId: !!effectiveAppId },
    });
  }

  try {
    const freshStart = req.body.freshStart === true;
    const authToken = req.body.authToken;
    const result = await sessionManager.startSession(
      userId,
      null,
      effectiveAppId,
      (event, data) => { io.to(`user:${userId}`).emit(event, data); },
      { freshStart, authToken }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force a fresh start — clears all stale session data and generates a new QR
app.post('/session/fresh-start', async (req, res) => {
  const { userId } = req.body;
  const effectiveAppId = req.body.appId || process.env.BASE44_APP_ID;
  if (!userId || !effectiveAppId) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  try {
    await sessionManager.disconnectSession(userId);
    const authToken = req.body.authToken;
    const result = await sessionManager.startSession(
      userId,
      null,
      effectiveAppId,
      (event, data) => { io.to(`user:${userId}`).emit(event, data); },
      { freshStart: true, authToken }
    );
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

// Refresh auth token from frontend (called automatically on page load)
app.post('/session/refresh-token', async (req, res) => {
  const { userId, authToken } = req.body;
  const appId = req.body.appId || process.env.BASE44_APP_ID;
  if (!userId || !authToken) {
    return res.status(400).json({ error: 'userId and authToken required' });
  }
  try {
    const result = await sessionManager.reconnectWithToken(userId, authToken, appId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session status
app.get('/session/status/:userId', (req, res) => {
  const status = sessionManager.getStatus(req.params.userId);
  res.json(status);
});

// Rescan recent messages in all active groups
app.post('/session/rescan/:userId', async (req, res) => {
  const appId = req.body.appId || process.env.BASE44_APP_ID;
  if (!appId) return res.status(400).json({ error: 'Missing appId' });
  try {
    const authToken = req.body.authToken;
    if (authToken) {
      require('./base44Api').setUserToken(req.params.userId, authToken);
    }
    const result = await sessionManager.rescanMessages(req.params.userId, authToken, appId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all WhatsApp group names (for debugging group name mismatch)
app.get('/session/groups/:userId', async (req, res) => {
  try {
    const groups = await sessionManager.getGroups(req.params.userId);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify that the WhatsApp connection is actually alive (not just in-memory status)
app.get('/session/verify/:userId', async (req, res) => {
  try {
    const result = await sessionManager.verifyConnection(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// Standalone API diagnostic — tests the Base44 SDK connection without needing an active WhatsApp session
app.post('/debug/api-test/:userId', async (req, res) => {
  const userId = req.params.userId;
  const authToken = req.body.authToken;
  try {
    const base44Api = require('./base44Api');
    const result = await base44Api.runApiDiagnostic(userId, authToken);
    res.json(result);
  } catch (err) {
    res.json({ authError: err.message, userId });
  }
});

// Full diagnostics — library version, Chromium, session event log
app.get('/session/diagnostics/:userId', (req, res) => {
  try {
    const diag = sessionManager.getDiagnostics(req.params.userId);
    res.json(diag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  // Auto-reconnect WhatsApp sessions that were previously connected
  const appId = process.env.BASE44_APP_ID;
  console.log(`Server ready. Waiting for auth tokens from the app (appId=${appId ? 'set' : 'MISSING'}).`);
});
