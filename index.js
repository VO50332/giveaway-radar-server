const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sessionManager = require('./sessionManager');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessionManager.getSessionCount() }));

app.post('/session/start', async (req, res) => {
  const { userId, appId } = req.body;
  const apiKey = req.body.apiKey || process.env.BASE44_API_KEY;
  const effectiveAppId = appId || process.env.BASE44_APP_ID;
  if (!userId || !apiKey || !effectiveAppId) {
    return res.status(400).json({ error: 'Missing credentials', apiKey: !!apiKey, appId: !!effectiveAppId });
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

app.post('/session/disconnect', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await sessionManager.disconnectSession(userId);
  res.json({ success: true });
});

app.get('/session/status/:userId', (req, res) => {
  res.json(sessionManager.getStatus(req.params.userId));
});

io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(`user:${userId}`));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));