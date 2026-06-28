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
  const hasAuth = process.env.BASE44_USER_EMAIL && process.env.BASE44_USER_PASSWORD;
  if (!userId || !hasAuth || !effectiveAppId) {
    return res.status(400).json({
      error: 'Missing credentials',
      details: {
        userId: !!userId,
        hasEmail: !!process.env.BASE44_USER_EMAIL,
        hasPassword: !!process.env.BASE44_USER_PASSWORD,
        appId: !!effectiveAppId,
        hint: hasAuth ? undefined : 'Set BASE44_USER_EMAIL and BASE44_USER_PASSWORD env vars on Railway',
      }
    });
  }

  try {
    const freshStart = req.body.freshStart === true;
    const result = await sessionManager.startSession(
      userId,
      null,
      effectiveAppId,
      (event, data) => { io.to(`user:${userId}`).emit(event, data); },
      { freshStart }
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
    const result = await sessionManager.startSession(
      userId,
      null,
      effectiveAppId,
      (event, data) => { io.to(`user:${userId}`).emit(event, data); },
      { freshStart: true }
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
    const result = await sessionManager.rescanMessages(req.params.userId, null, appId);
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
app.get('/debug/api-test/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const base44Api = require('./base44Api');
    const result = await base44Api.runApiDiagnostic(userId);
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
  const hasAuth = process.env.BASE44_USER_EMAIL && process.env.BASE44_USER_PASSWORD;
  const appId = process.env.BASE44_APP_ID;
  if (hasAuth && appId) {
    setTimeout(() => sessionManager.autoReconnect(null, appId), 3000);
  } else {
    console.log('Auto-reconnect skipped: BASE44_USER_EMAIL, BASE44_USER_PASSWORD, or BASE44_APP_ID not set');
  }
});
