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
    const dbSession = await base44Api.getWhatsAppSession(userId, apiKey, appId);
    if (!dbSession || !dbSession.session_data) return false;

    const files = JSON.parse(dbSession.session_data);
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
  const authToken = opts.authToken;
  if (authToken) {
    base44Api.setUserToken(userId, authToken);
    console.log(`[${userId}] Auth token stored from frontend`);
  }

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
    session.qr = null; // Clear in-memory QR so the status poll detects connected
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

    // Persist session to DB FIRST — before any potentially-hanging operations
    // so session_data is saved even if getChats() hangs later
    await saveSessionToDb(userId, apiKey, appId);

    // Wait for WhatsApp to sync chats — on fresh connections this takes 20-40s
    logEvent(userId, 'sync_wait_start', {});
    await new Promise(r => setTimeout(r, 20000));

    // Try to load groups via getChats — but this often hangs on Railway, so don't retry aggressively
    let chats = await Promise.race([
      client.getChats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_60s')), 60000)),
    ]).catch(err => {
      logEvent(userId, 'getChats_failed', { error: err.message });
      return [];
    });
    let groups = chats.filter(c => c.isGroup);
    logEvent(userId, 'groups_loaded', { count: groups.length, total_chats: chats.length });

    // Only retry once if getChats returned no groups
    if (groups.length === 0) {
      logEvent(userId, 'groups_empty_retrying', {});
      await new Promise(r => setTimeout(r, 30000));
      chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_60s')), 60000)),
      ]).catch(err => {
        logEvent(userId, 'getChats_retry_failed', { error: err.message });
        return [];
      });
      groups = chats.filter(c => c.isGroup);
      logEvent(userId, 'groups_retry', { count: groups.length });
    }

    session.groups = groups;
    session.groups_count = groups.length;
    logEvent(userId, 'groups_final', { count: groups.length });
    await base44Api.updateSession(userId, apiKey, appId, { groups_count: groups.length });
    emit('groups', { count: groups.length });

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
  const matchedGroup = monitoredGroups.find(g => g.group_name.trim() === groupName.trim() && g.is_active);
  if (!matchedGroup) return;

  // Populate group_id if missing — future rescans can use getChatById() instead of getChats()
  if (!matchedGroup.group_id || matchedGroup.group_id !== chat.id._serialized) {
    await base44Api.updateConnectedGroup(userId, apiKey, appId, matchedGroup.id, { group_id: chat.id._serialized });
  }

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

async function syncGroupIds(userId, client, apiKey, appId) {
  const sess = sessions.get(userId);
  let groups = sess?.groups;
  if (!groups || groups.length === 0) {
    try {
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_60s')), 60000)),
      ]).catch(() => []);
      groups = chats.filter ? chats.filter(c => c.isGroup) : [];
      if (sess) sess.groups = groups;
    } catch {
      groups = [];
    }
  }
  if (!groups || groups.length === 0) {
    console.log(`[${userId}] syncGroupIds: no WhatsApp groups available`);
    return await base44Api.getConnectedGroups(userId, apiKey, appId);
  }

  const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
  let updated = 0;
  for (const mg of monitoredGroups) {
    const match = groups.find(g => g.name?.trim() === mg.group_name?.trim());
    if (match && (!mg.group_id || mg.group_id !== match.id._serialized)) {
      await base44Api.updateConnectedGroup(userId, apiKey, appId, mg.id, { group_id: match.id._serialized });
      mg.group_id = match.id._serialized;
      updated++;
    }
  }
  console.log(`[${userId}] syncGroupIds: ${updated}/${monitoredGroups.length} groups updated`);
  return monitoredGroups;
}

async function scanRecentMessages(userId, client, apiKey, appId, emit) {
  const sess = sessions.get(userId);
  try {
    const monitoredGroups = await syncGroupIds(userId, client, apiKey, appId);
    const activeGroups = monitoredGroups.filter(g => g.is_active);
    console.log(`[${userId}] Scanning recent messages in ${activeGroups.length} active groups`);
    if (sess) { sess.eventLog = sess.eventLog || []; sess.eventLog.push({ type: 'scan_start', data: { activeGroups: activeGroups.length, groupNames: activeGroups.map(g => g.group_name) }, ts: Date.now() }); }

    // Use getChatById for groups that have a stored group_id — much lighter than getChats()
    for (const group of activeGroups) {
      if (!group.group_id) {
        console.log(`[${userId}] Group "${group.group_name}" has no group_id — skipping (will be populated when a message arrives)`);
        if (sess) { sess.eventLog.push({ type: 'group_no_id', data: { name: group.group_name }, ts: Date.now() }); }
        continue;
      }
      try {
        const chat = await Promise.race([
          client.getChatById(group.group_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById_timeout_30s')), 30000)),
        ]);
        if (!chat) continue;
        const messages = await chat.fetchMessages({ limit: 50 });
        console.log(`[${userId}] Scanned ${messages.length} messages in "${group.group_name}"`);
        if (sess) { sess.eventLog.push({ type: 'scan_group', data: { name: group.group_name, messages: messages.length }, ts: Date.now() }); }
        for (const msg of messages) {
          if (!msg.body) continue;
          await processMessage(userId, apiKey, appId, client, msg, emit);
        }
      } catch (err) {
        console.log(`[${userId}] getChatById failed for "${group.group_name}": ${err.message}`);
        if (sess) { sess.eventLog.push({ type: 'getChatById_failed', data: { name: group.group_name, error: err.message }, ts: Date.now() }); }
      }
    }
    console.log(`[${userId}] History scan complete`);
    if (sess) { sess.eventLog.push({ type: 'scan_complete', data: {}, ts: Date.now() }); }
  } catch (err) {
    console.error(`[${userId}] History scan error:`, err.message);
    if (sess) { sess.eventLog.push({ type: 'scan_error', data: { error: err.message }, ts: Date.now() }); }
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

async function rescanMessages(userId, apiKey, appId) {
  if (!sessions.has(userId)) return { error: 'no_active_session' };
  const session = sessions.get(userId);
  if (session.status !== 'connected') return { error: 'not_connected', status: session.status };
  let scanned = 0;
  let skipped = 0;
  const debug = { hasToken: true, hasAppId: !!appId, appIdValue: appId, userId };
  // Diagnostic via SDK
  try {
    const allGroups = await base44Api.listAllConnectedGroups(userId);
    debug.rawAll = { count: allGroups.length, sample: allGroups.length > 0 ? { id: allGroups[0].id, name: allGroups[0].group_name, user_id: allGroups[0].user_id } : null };
  } catch (rawErr) {
    debug.rawApiError = { message: rawErr.message };
  }
  try {
    const monitoredGroups = await syncGroupIds(userId, session.client, apiKey, appId);
    console.log(`[${userId}] Rescan: getConnectedGroups returned ${monitoredGroups.length} groups, appId=${appId}`);
    debug.groupsReturned = monitoredGroups.length;
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_groups_loaded', data: { total: monitoredGroups.length, names: monitoredGroups.map(g => g.group_name) }, ts: Date.now() }); }
    const activeGroups = monitoredGroups.filter(g => g.is_active);
    console.log(`[${userId}] Rescan: ${activeGroups.length} active groups`);
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_start', data: { activeGroups: activeGroups.length, names: activeGroups.map(g => g.group_name) }, ts: Date.now() }); }

    for (const group of activeGroups) {
      if (!group.group_id) {
        console.log(`[${userId}] Rescan: "${group.group_name}" has no group_id — skipping`);
        skipped++;
        continue;
      }
      try {
        const chat = await Promise.race([
          session.client.getChatById(group.group_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById_timeout_30s')), 30000)),
        ]);
        const messages = await chat.fetchMessages({ limit: 50 });
        console.log(`[${userId}] Rescan: ${messages.length} msgs in "${group.group_name}"`);
        if (session.eventLog) { session.eventLog.push({ type: 'rescan_group', data: { name: group.group_name, messages: messages.length }, ts: Date.now() }); }
        for (const msg of messages) {
          if (!msg.body) continue;
          await processMessage(userId, apiKey, appId, session.client, msg, () => {});
          scanned++;
        }
      } catch (err) {
        console.log(`[${userId}] Rescan: getChatById failed for "${group.group_name}": ${err.message}`);
        if (session.eventLog) { session.eventLog.push({ type: 'rescan_group_failed', data: { name: group.group_name, error: err.message }, ts: Date.now() }); }
      }
    }
    console.log(`[${userId}] Rescan complete: ${scanned} messages processed, ${skipped} groups skipped (no group_id)`);
    return { scanned, skipped, totalGroups: monitoredGroups.length, activeGroups: activeGroups.length, debug };
  } catch (err) {
    console.error(`[${userId}] Rescan error:`, err.message);
    return { error: err.message };
  }
}

function getSessionCount() {
  return sessions.size;
}

async function getGroups(userId) {
  if (!sessions.has(userId)) return { error: 'no_active_session' };
  const session = sessions.get(userId);
  if (session.status !== 'connected' || !session.client) return { error: 'not_connected', status: session.status };
  const chats = await Promise.race([
    session.client.getChats(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_60s')), 60000)),
  ]).catch(err => {
    return { error: err.message };
  });
  if (!Array.isArray(chats)) return { error: chats.error || 'getChats_failed' };
  const groups = chats.filter(c => c.isGroup).map(c => ({ name: c.name, id: c.id._serialized }));
  return { groups };
}

// Auto-reconnect all sessions marked "connected" in the DB
// Called on server startup to restore connections after redeploy
// If session_data exists, restore from it; otherwise start fresh (new QR)
async function autoReconnect(apiKey, appId) {
  // On server restart, we don't have user tokens (they're stored in memory).
  // Sessions are restored when users open the app and send their token via /session/refresh-token.
  console.log('[autoReconnect] Skipped — waiting for auth tokens from the app');
}

// Called when a user's token arrives from the frontend — restores their WhatsApp session
async function reconnectWithToken(userId, authToken, appId) {
  try {
    base44Api.setUserToken(userId, authToken);
    const dbSession = await base44Api.getWhatsAppSession(userId);
    if (!dbSession) {
      console.log(`[reconnectWithToken] No session in DB for user ${userId}`);
      return { status: 'no_session' };
    }
    if (sessions.has(userId) && sessions.get(userId).status === 'connected') {
      return { status: 'already_connected' };
    }
    if (dbSession.status === 'connected' || dbSession.session_data) {
      console.log(`[reconnectWithToken] Restoring WhatsApp session for user ${userId}`);
      return await startSession(userId, null, appId, () => {});
    }
    return { status: dbSession.status };
  } catch (err) {
    console.error(`[reconnectWithToken] error for ${userId}:`, err.message);
    return { error: err.message };
  }
}

module.exports = { startSession, disconnectSession, getStatus, getSessionCount, autoReconnect, reconnectWithToken, verifyConnection, getDiagnostics, rescanMessages, getGroups };
