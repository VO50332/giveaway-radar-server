/* eslint-env node */
/* eslint-disable no-undef */
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const base44Api = require('./base44Api');
const matcher = require('./matcher');

// Map of userId -> { client, status, apiKey, appId }
const sessions = new Map();
const DATA_DIR = process.env.DATA_DIR || '/data';

// --- DB-backed session persistence ---
// Serialize the session directory to a single JSON string, save to DB.
async function saveSessionToDb(userId, apiKey, appId) {
  try {
    const sessionDir = path.join(DATA_DIR, 'session-' + userId);
    if (!fs.existsSync(sessionDir)) return;

    const files = {};
    function walk(dir, relPath = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, rel);
        } else {
          const buf = fs.readFileSync(fullPath);
          files[rel] = buf.toString('base64');
        }
      }
    }
    walk(sessionDir);

    const json = JSON.stringify(files);
    await base44Api.updateSession(userId, apiKey, appId, { session_data: json });
    console.log(`[${userId}] Session saved to DB (${Math.round(json.length / 1024)}KB)`);
  } catch (err) {
    console.error(`[${userId}] saveSessionToDb error:`, err.message);
  }
}

// Restore session files from DB to the filesystem before client init.
async function restoreSessionFromDb(userId, apiKey, appId) {
  try {
    const api = require('./base44Api');
    // We need to read the session_data directly
    const axios = require('axios');
    const BASE_URL = 'https://api.base44.com/api/apps';
    const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
    const params = `?filter=${encodeURIComponent(JSON.stringify({ user_id: userId }))}`;
    const res = await axios.get(`${BASE_URL}/${appId}/entities/WhatsAppSession${params}`, { headers });
    const dbSessions = res.data;
    if (!dbSessions || dbSessions.length === 0 || !dbSessions[0].session_data) return false;

    const files = JSON.parse(dbSessions[0].session_data);
    const sessionDir = path.join(DATA_DIR, 'session-' + userId);
    fs.mkdirSync(sessionDir, { recursive: true });

    for (const [relPath, base64] of Object.entries(files)) {
      const fullPath = path.join(sessionDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    }
    console.log(`[${userId}] Session restored from DB (${Object.keys(files).length} files)`);
    return true;
  } catch (err) {
    console.error(`[${userId}] restoreSessionFromDb error:`, err.message);
    return false;
  }
}

// Remove the local session directory and any stale files.
function clearSessionFiles(userId) {
  const sessionDir = path.join(DATA_DIR, 'session-' + userId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`[${userId}] Cleared local session files`);
  }
}

async function startSession(userId, apiKey, appId, emit, opts = {}) {
  const freshStart = opts.freshStart === true;

  // If session already exists and is connected, return
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === 'connected' && !freshStart) {
      return { status: 'already_connected' };
    }
    // Destroy old session before recreating
    await destroySession(userId);
  }

  if (freshStart) {
    // Wipe stale local files + clear session_data in DB so WhatsApp does a clean link
    clearSessionFiles(userId);
    await base44Api.updateSession(userId, apiKey, appId, {
      session_data: null,
      qr_code: null,
      status: 'pending_qr',
    });
    console.log(`[${userId}] Fresh start — cleared all old session data`);
  } else {
    // Restore session from DB before initializing (avoids re-scan QR on redeploy)
    const restored = await restoreSessionFromDb(userId, apiKey, appId);
    if (restored) {
      sessions.set(userId, { client: null, status: 'restoring', apiKey, appId });
      emit('status', { status: 'restoring' });
    }
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId, dataPath: DATA_DIR }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  });

  sessions.set(userId, { client, status: 'initializing', apiKey, appId, eventLog: [] });

  // Helper: log + emit an event for diagnostics
  function logEvent(userId, type, data = {}) {
    const sess = sessions.get(userId);
    if (sess) {
      sess.eventLog = sess.eventLog || [];
      sess.eventLog.push({ type, data, ts: Date.now() });
      if (sess.eventLog.length > 50) sess.eventLog.shift();
    }
    const detail = typeof data === 'object' ? JSON.stringify(data) : data;
    console.log(`[${userId}] EVENT: ${type} ${detail}`);
    emit('log', { type, data });
  }

  // Safety timeout: if no QR or ready within 90s, force a fresh restart
  const initTimeout = setTimeout(async () => {
    const sess = sessions.get(userId);
    if (sess && sess.status !== 'connected' && sess.status !== 'pending_qr') {
      console.log(`[${userId}] Init timeout — forcing fresh restart`);
      logEvent(userId, 'init_timeout', { status: sess?.status });
      emit('status', { status: 'timeout_restarting' });
      try { await client.destroy(); } catch (_) {}
      sessions.delete(userId);
      startSession(userId, apiKey, appId, emit, { freshStart: true });
    }
  }, 90_000);

  client.on('loading_screen', (percent, message) => {
    logEvent(userId, 'loading_screen', { percent, message });
  });

  client.on('authenticated', () => {
    logEvent(userId, 'authenticated', {});
  });

  client.on('auth_failure', async (msg) => {
    clearTimeout(initTimeout);
    logEvent(userId, 'auth_failure', { msg });
    console.error(`[${userId}] Auth failure: ${msg}`);
    await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });

  client.on('qr', async (qr) => {
    const sess = sessions.get(userId);
    sess.status = 'pending_qr';
    sess.qr = qr;
    sess.qrGeneratedAt = Date.now();
    logEvent(userId, 'qr_generated', { length: qr.length });
    emit('qr', { qr });
    console.log(`[${userId}] QR generated (length: ${qr.length})`);
    await base44Api.updateSession(userId, apiKey, appId, { status: 'pending_qr', qr_code: qr });
  });

  client.on('ready', async () => {
    clearTimeout(initTimeout);
    const session = sessions.get(userId);
    session.status = 'connected';
    logEvent(userId, 'ready', {});
    emit('ready', { status: 'connected' });
    await base44Api.updateSession(userId, apiKey, appId, { status: 'connected', qr_code: null });
    console.log(`[${userId}] WhatsApp connected`);

    // Re-verify after 10s — catches connections that drop right after ready
    setTimeout(async () => {
      try {
        const state = await Promise.race([
          client.getState(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        logEvent(userId, 'post_ready_verify', { state });
      } catch (err) {
        logEvent(userId, 'post_ready_verify_failed', { error: err.message });
        session.status = 'disconnected';
        await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
        emit('disconnected', { reason: 'post_ready_verify_failed' });
      }
    }, 10000);

    // Load groups and update DB
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    session.groups = groups;
    session.groups_count = groups.length;
    await base44Api.updateSession(userId, apiKey, appId, { groups_count: groups.length });
    emit('groups', { count: groups.length });

    // Persist session to DB so it survives redeploys
    await saveSessionToDb(userId, apiKey, appId);

    // Scan recent messages in active groups for matches
    await scanRecentMessages(userId, client, apiKey, appId, emit);
  });

  client.on('message', async (msg) => {
    await processMessage(userId, apiKey, appId, client, msg, emit);
  });

  client.on('disconnected', async (reason) => {
    clearTimeout(initTimeout);
    logEvent(userId, 'disconnected', { reason: String(reason) });
    if (sessions.has(userId)) {
      sessions.get(userId).status = 'disconnected';
    }
    emit('disconnected', { reason });
    await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });

  client.initialize().catch(err => {
    clearTimeout(initTimeout);
    logEvent(userId, 'initialize_failed', { error: err.message });
    console.error(`[${userId}] client.initialize() failed:`, err.message);
    base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });
  return { status: 'initializing' };
}

async function processMessage(userId, apiKey, appId, client, msg, emit) {
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupName = chat.name;
  const content = msg.body || '';
  const sender = msg.author || msg.from;

  const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
  const isMonitored = monitoredGroups.some(g => g.group_name === groupName && g.is_active);
  if (!isMonitored) return;

  await base44Api.createGroupMessage(userId, apiKey, appId, {
    user_id: userId,
    group_id: chat.id._serialized,
    group_name: groupName,
    message_id: msg.id._serialized,
    sender_name: sender,
    content,
    received_at: new Date(msg.timestamp * 1000).toISOString(),
  });

  const wishlistItems = await base44Api.getWishlistItems(userId, apiKey, appId);
  const activeItems = wishlistItems.filter(i => i.status === 'watching');

  for (const item of activeItems) {
    const matchResult = matcher.checkMatch(content, item.keywords);
    if (!matchResult.matched) continue;

    const availabilityStatus = matcher.detectAvailability(content);

    const match = await base44Api.createMatch(userId, apiKey, appId, {
      user_id: userId,
      wishlist_item_id: item.id,
      wishlist_item_title: item.title,
      group_name: groupName,
      sender_name: sender,
      message_content: content,
      matched_keywords: matchResult.keywords,
      availability_status: availabilityStatus,
      notification_sent: false,
      matched_at: new Date().toISOString(),
    });

    emit('match', { match, item });

    if (item.notify_via_whatsapp) {
      const userPhone = await base44Api.getUserPhone(userId, apiKey, appId);
      if (userPhone) {
        const notifMsg = `🎯 *GiveAway Match!*\n\n*Item:* ${item.title}\n*Group:* ${groupName}\n*Message:* ${content.slice(0, 200)}\n*Status:* ${availabilityStatus === 'available' ? '✅ Available' : availabilityStatus === 'taken' ? '❌ Taken' : '❓ Unknown'}`;
        await client.sendMessage(`${userPhone}@c.us`, notifMsg);
      }

      await base44Api.createNotification(userId, apiKey, appId, {
        user_id: userId,
        match_id: match.id,
        wishlist_item_title: item.title,
        group_name: groupName,
        message_preview: content.slice(0, 150),
        channel: 'whatsapp',
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
    }
  }
}

async function scanRecentMessages(userId, client, apiKey, appId, emit) {
  try {
    const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
    const activeGroups = monitoredGroups.filter(g => g.is_active);
    console.log(`[${userId}] Scanning recent messages in ${activeGroups.length} active groups`);

    for (const group of activeGroups) {
      const chats = await client.getChats();
      const chat = chats.find(c => c.isGroup && c.name === group.group_name);
      if (!chat) continue;

      const messages = await chat.fetchMessages({ limit: 50 });
      console.log(`[${userId}] Scanned ${messages.length} messages in "${group.group_name}"`);

      for (const msg of messages) {
        if (!msg.body) continue;
        await processMessage(userId, apiKey, appId, client, msg, emit);
      }
    }
    console.log(`[${userId}] History scan complete`);
  } catch (err) {
    console.error(`[${userId}] History scan error:`, err.message);
  }
}

async function disconnectSession(userId) {
  await destroySession(userId);
}

async function destroySession(userId) {
  if (!sessions.has(userId)) return;
  const session = sessions.get(userId);
  try {
    await session.client.destroy();
  } catch (_) {}
  sessions.delete(userId);
  // Also clear stale local session files so they don't interfere with the next link
  clearSessionFiles(userId);
}

function getStatus(userId) {
  if (!sessions.has(userId)) return { status: 'not_started' };
  const s = sessions.get(userId);
  return { status: s.status, qr: s.qr || null, eventLog: s.eventLog || [] };
}

// Full diagnostics — checks Chromium, library version, and session state
function getDiagnostics(userId) {
  const diag = {
    libraryVersion: require('whatsapp-web.js').version || 'unknown',
    chromiumPath: process.env.PUPPETEER_EXECUTABLE_PATH || 'not_set',
    dataDir: DATA_DIR,
    dataDirExists: fs.existsSync(DATA_DIR),
    sessionCount: sessions.size,
    session: null,
  };
  if (userId && sessions.has(userId)) {
    const s = sessions.get(userId);
    diag.session = {
      status: s.status,
      hasClient: !!s.client,
      qrGeneratedAt: s.qrGeneratedAt || null,
      groupsCount: s.groups_count || (s.groups ? s.groups.length : 0),
      eventLog: s.eventLog || [],
    };
  }
  return diag;
}

// Actually ping the WhatsApp client to see if the connection is truly alive
async function verifyConnection(userId) {
  if (!sessions.has(userId)) {
    return { connected: false, error: 'no_session' };
  }
  const session = sessions.get(userId);
  if (session.status !== 'connected') {
    return { connected: false, error: `status_is_${session.status}` };
  }
  if (!session.client) {
    return { connected: false, error: 'no_client' };
  }
  try {
    // getState() throws if the connection is dead
    const state = await Promise.race([
      session.client.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('verify_timeout')), 15000)),
    ]);
    return { connected: true, state };
  } catch (err) {
    console.error(`[${userId}] Verify failed:`, err.message);
    // Mark as disconnected since the connection is dead
    session.status = 'disconnected';
    return { connected: false, error: err.message };
  }
}

function getSessionCount() {
  return sessions.size;
}

// Auto-reconnect all sessions that have saved session_data in the DB
// Called on server startup to restore connections after redeploy
async function autoReconnect(apiKey, appId) {
  try {
    const axios = require('axios');
    const BASE_URL = 'https://api.base44.com/api/apps';
    const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
    const params = `?filter=${encodeURIComponent(JSON.stringify({ status: 'connected' }))}`;
    const res = await axios.get(`${BASE_URL}/${appId}/entities/WhatsAppSession${params}`, { headers });
    const connectedSessions = res.data || [];

    for (const sess of connectedSessions) {
      if (sess.session_data && sess.user_id) {
        console.log(`[autoReconnect] Restoring session for user ${sess.user_id}`);
        startSession(sess.user_id, apiKey, appId, () => {}).catch(err => {
          console.error(`[autoReconnect] Failed for ${sess.user_id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error('[autoReconnect] error:', err.message);
  }
}

module.exports = { startSession, disconnectSession, getStatus, getSessionCount, autoReconnect, verifyConnection, getDiagnostics };
