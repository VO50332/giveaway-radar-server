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

// --- WhatsApp Web version auto-resolution ---
// The wa-version archive only keeps a rolling window of builds, so any hardcoded
// webVersion pin eventually 404s and initialization fails ("Couldn't load version X
// from the archive"). Instead of pinning, resolve the OLDEST build currently in the
// archive from the GitHub contents API at session start — it's always present, and
// it's the most stable end of the rolling window. Falls back to a known-good pin
// only if the API is unreachable (rate limit / outage).
// Returns a version string, or null if the archive is unreachable (in which
// case we skip pinning entirely and let whatsapp-web.js load the current
// version from WhatsApp's servers — less stable but always works, unlike a
// stale pin that 404s).
async function resolveWebVersion() {
  // Strategy 1: GitHub contents API (directory listing)
  try {
    const res = await fetch('https://api.github.com/repos/wppconnect-team/wa-version/contents/html?ref=main', {
      headers: { 'User-Agent': 'giveaway-radar' },
    });
    if (res.ok) {
      const files = await res.json();
      const versions = files
        .filter(f => f.name && f.name.endsWith('.html'))
        .map(f => f.name.replace(/\.html$/, ''))
        .sort();
      if (versions.length > 0) {
        const oldest = versions[0];
        console.log(`[sessionManager] Resolved WhatsApp Web version ${oldest} via contents API (${versions.length} builds)`);
        return oldest;
      }
    } else {
      console.error(`[sessionManager] resolveWebVersion contents API: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[sessionManager] resolveWebVersion contents API failed: ${err.message}`);
  }

  // Strategy 2: Git trees API (handles large directories, different rate-limit bucket)
  try {
    const res = await fetch('https://api.github.com/repos/wppconnect-team/wa-version/git/trees/main?recursive=1', {
      headers: { 'User-Agent': 'giveaway-radar' },
    });
    if (res.ok) {
      const data = await res.json();
      const versions = (data.tree || [])
        .filter(f => f.path && f.path.startsWith('html/') && f.path.endsWith('.html'))
        .map(f => f.path.replace('html/', '').replace(/\.html$/, ''))
        .sort();
      if (versions.length > 0) {
        const oldest = versions[0];
        console.log(`[sessionManager] Resolved WhatsApp Web version ${oldest} via git trees API (${versions.length} builds)`);
        return oldest;
      }
    } else {
      console.error(`[sessionManager] resolveWebVersion git trees API: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[sessionManager] resolveWebVersion git trees API failed: ${err.message}`);
  }

  console.error(`[sessionManager] resolveWebVersion: all strategies failed — skipping version pin (library default will be used)`);
  return null;
}

// --- DB-backed session persistence ---
// Serialize the session directory to a single JSON string, save to DB.
async function saveSessionToDb(userId, apiKey, appId) {
  const sess = sessions.get(userId);
  const logSave = (type, data = {}) => {
    console.log(`[${userId}] SAVE ${type}: ${JSON.stringify(data)}`);
    if (sess) {
      sess.eventLog = sess.eventLog || [];
      sess.eventLog.push({ type: `save_${type}`, data, ts: Date.now() });
      if (sess.eventLog.length > 80) sess.eventLog.shift();
    }
  };
  try {
    // LocalAuth stores under .wwebjs_auth/session-{clientId}/, NOT session-{clientId}/
    const sessionDir = path.join(DATA_DIR, '.wwebjs_auth', 'session-' + userId);
    if (!fs.existsSync(sessionDir)) {
      logSave('dir_not_found', { dir: sessionDir });
      return;
    }

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
    logSave('files_collected', { count: Object.keys(files).length });

    const json = JSON.stringify(files);
    logSave('json_size', { kb: Math.round(json.length / 1024) });
    // session_data is too large for an entity field, so store it as a private
    // file and keep only the file_uri in the entity.
    const fileUri = await base44Api.uploadSessionData(userId, json);
    if (!fileUri) {
      logSave('upload_failed', { reason: 'uploadSessionData returned null' });
      return;
    }
    logSave('uploaded', { fileUri: fileUri.substring(0, 80) });
    await base44Api.updateSession(userId, apiKey, appId, { session_data: fileUri });
    logSave('db_updated', { kb: Math.round(json.length / 1024) });
  } catch (err) {
    logSave('error', { message: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  }
}

// Restore session files from DB to the filesystem before client init.
async function restoreSessionFromDb(userId, apiKey, appId) {
  try {
    const dbSession = await base44Api.getWhatsAppSession(userId, apiKey, appId);
    if (!dbSession || !dbSession.session_data) return false;

    // session_data now holds a private-file uri (not the JSON itself) — download it.
    const json = await base44Api.downloadSessionData(userId, dbSession.session_data);
    if (!json) return false;
    const files = JSON.parse(json);
    // LocalAuth stores under .wwebjs_auth/session-{clientId}/
    const sessionDir = path.join(DATA_DIR, '.wwebjs_auth', 'session-' + userId);
    fs.mkdirSync(sessionDir, { recursive: true });

    for (const [relPath, base64] of Object.entries(files)) {
      const fullPath = path.join(sessionDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    }
    console.log(`[${userId}] Session restored from DB private file (${Object.keys(files).length} files)`);
    return true;
  } catch (err) {
    console.error(`[${userId}] restoreSessionFromDb error:`, err.message);
    return false;
  }
}

// Remove the local session directory and any stale files.
// LocalAuth creates TWO directories:
//   1. {DATA_DIR}/.wwebjs_auth/session-{clientId}/  — WhatsApp auth credentials
//   2. {DATA_DIR}/session-{clientId}/               — Chromium user-data-dir (profile)
// If we only clear #1, Puppeteer fails on the next launch with
// "The browser is already running for {DATA_DIR}/session-{clientId}" because the
// Chromium profile dir (with its SingletonLock) is still on disk.
async function clearSessionFiles(userId) {
  const dirs = [
    path.join(DATA_DIR, '.wwebjs_auth', 'session-' + userId), // auth files
    path.join(DATA_DIR, 'session-' + userId),                 // Chromium profile
  ];
  let clearedAny = false;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    // Retry a few times — Chromium may still be releasing file handles when we
    // remove the profile dir, causing ENOTEMPTY on the rmdir. Never throw: a
    // leftover file shouldn't abort the rescan; LocalAuth recreates the structure.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        clearedAny = true;
        break;
      } catch (err) {
        if (attempt === 5) {
          console.error(`[${userId}] clearSessionFiles failed for ${dir} after 5 attempts:`, err.message);
        } else {
          await new Promise(r => setTimeout(r, 200 * attempt));
        }
      }
    }
  }
  if (clearedAny) console.log(`[${userId}] Cleared local session files (auth + Chromium profile)`);
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
    // Destroy old session before recreating (destroySession waits for Chromium exit)
    await destroySession(userId);
  } else if (freshStart) {
    // No in-memory session, but the Chromium profile dir may still be on disk
    // from a previous run that crashed/redeployed. Clear it so Puppeteer doesn't
    // fail with "The browser is already running".
    await clearSessionFiles(userId);
  }

  if (freshStart) {
    // Wipe stale local files + clear session_data in DB so WhatsApp does a clean link
    await clearSessionFiles(userId);
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

  // Resolve the oldest WhatsApp Web build currently in the wa-version archive so the
  // version pin never 404s as the archive rolls forward. (See resolveWebVersion above.)
  const webVersion = await resolveWebVersion();
  const clientOpts = {
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
  };
  if (webVersion) {
    clientOpts.webVersion = webVersion;
    clientOpts.webVersionCache = {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
      strict: true,
    };
  } else {
    console.log(`[${userId}] No version pin — whatsapp-web.js will load the current version from WhatsApp directly`);
  }
  const client = new Client(clientOpts);

  sessions.set(userId, { client, status: 'initializing', apiKey, appId, eventLog: [], initStartedAt: Date.now() });

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
    try {
      const wv = await client.getWWebVersion();
      logEvent(userId, 'wweb_version', { version: wv });
      console.log(`[${userId}] WhatsApp connected (Web v${wv})`);
    } catch (_) {
      console.log(`[${userId}] WhatsApp connected`);
    }

    // Auto-download photos so the media blob is available when downloadMedia() is
    // called — on linked companion devices media isn't fetched by default.
    try { await client.setAutoDownloadPhotos(true); } catch (_) {}

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

    // Periodic heartbeat — a restored session can report "CONNECTED" via
    // getState yet have a dead Chromium page (getChats throws "Target closed")
    // minutes later, leaving a stuck session until a manual Rescan. Ping every
    // 3 min; on failure, fresh-restart so a new QR is generated automatically.
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.heartbeat = setInterval(async () => {
      try {
        await Promise.race([
          client.getState(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
        ]);
      } catch (err) {
        if (session.status !== 'connected') return; // already handling disconnect
        logEvent(userId, 'heartbeat_failed', { error: err.message });
        clearInterval(session.heartbeat);
        session.heartbeat = null;
        session.status = 'disconnected';
        await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
        emit('disconnected', { reason: 'heartbeat_failed' });
        try { await client.destroy(); } catch (_) {}
        sessions.delete(userId);
        await clearSessionFiles(userId);
        setTimeout(() => startSession(userId, apiKey, appId, emit, { freshStart: true, authToken: apiKey }), 3000);
      }
    }, 180000);

    // Persist session to DB FIRST — before any potentially-hanging operations
    // so session_data is saved even if getChats() hangs later
    await saveSessionToDb(userId, apiKey, appId);

    // NOTE: we deliberately do NOT call client.getChats() here. On Railway's
    // limited RAM, loading every chat + message history right after connect
    // OOMs the container — it restarts and wipes the in-memory session map,
    // so every subsequent Rescan says "no active session on the server".
    // Instead, read the group count from the DB and only fetch the specific
    // monitored groups we already have a group_id for (light: getChatById).
    try {
      const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
      session.groups_count = monitoredGroups.length;
      logEvent(userId, 'groups_count_from_db', { count: monitoredGroups.length });
      await base44Api.updateSession(userId, apiKey, appId, { groups_count: monitoredGroups.length });
      emit('groups', { count: monitoredGroups.length });
    } catch (err) {
      logEvent(userId, 'groups_count_failed', { error: err.message });
    }

    // Scan recent messages ONLY in groups that already have a stored group_id.
    // Groups without a group_id are populated lazily when their next message
    // arrives (processMessage writes group_id). This keeps connect-time memory
    // usage flat regardless of how many chats the account has.
    await scanKnownGroups(userId, client, apiKey, appId, emit);
  });

  client.on('message', async (msg) => {
    await processMessage(userId, apiKey, appId, client, msg, emit);
  });

  // Handle emoji reactions (e.g. someone reacts with 💾/❌ to mark an item taken).
  // Reactions are separate from replies — hasQuotedMsg doesn't catch them.
  client.on('message_reaction', async (reaction) => {
    try {
      const emoji = reaction?.reaction || '';
      const parentMsgId = reaction?.msgId?._serialized;
      if (!parentMsgId || !emoji) return;
      if (matcher.detectAvailability(emoji) !== 'taken') return;
      const originalMatches = await base44Api.findMatchesByMessageId(userId, parentMsgId);
      for (const m of originalMatches) {
        if (m.availability_status !== 'taken') {
          await base44Api.updateMatch(userId, apiKey, appId, m.id, { availability_status: 'taken' });
          console.log(`[${userId}] Match ${m.id} marked as taken via reaction ${emoji}`);
        }
      }
    } catch (err) {
      console.log(`[${userId}] message_reaction handling failed: ${err.message}`);
    }
  });

  client.on('disconnected', async (reason) => {
    clearTimeout(initTimeout);
    logEvent(userId, 'disconnected', { reason: String(reason) });
    if (sessions.has(userId)) {
      const sess = sessions.get(userId);
      if (sess.heartbeat) { clearInterval(sess.heartbeat); sess.heartbeat = null; }
      sess.status = 'disconnected';
    }
    emit('disconnected', { reason });
    await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });

  client.initialize().catch(err => {
    clearTimeout(initTimeout);
    const fullErr = err?.stack || err?.message || String(err);
    logEvent(userId, 'initialize_failed', { error: fullErr });
    console.error(`[${userId}] client.initialize() failed:`, fullErr);
    base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });
  return { status: 'initializing' };
}

async function processMessage(userId, apiKey, appId, client, msg, emit, existingChat) {
  const chat = existingChat || await msg.getChat();
  if (!chat.isGroup) return;

  const groupName = chat.name;
  const content = msg.body || '';
  const sender = msg.author || msg.from;
  // In groups, msg.author is the sender's phone (e.g. "972501234567@c.us")
  const senderNumber = msg.author ? msg.author.replace('@c.us', '').replace('@g.us', '') : null;

  const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
  const matchedGroup = monitoredGroups.find(g => g.group_name.trim() === groupName.trim() && g.is_active);
  if (!matchedGroup) return;

  // Skip messages ending with a question mark — these are requests ("Does anyone
  // have X?"), not giveaway offers, so they're not useful as matches.
  const trimmedContent = content.trim();
  if (trimmedContent.endsWith('?') || trimmedContent.endsWith('؟')) return;

  // Detect "taken" replies: if this message is a reply (e.g. someone reacted with
  // 💾/❌) to an original giveaway post, mark that original match as taken so it
  // drops out of the active matches list.
  if (msg.hasQuotedMsg) {
    try {
      const quoted = await msg.getQuotedMessage();
      if (quoted && quoted.id?._serialized) {
        const replyAvailability = matcher.detectAvailability(msg.body || '');
        if (replyAvailability === 'taken') {
          const originalMatches = await base44Api.findMatchesByMessageId(userId, quoted.id._serialized);
          for (const m of originalMatches) {
            if (m.availability_status !== 'taken') {
              await base44Api.updateMatch(userId, apiKey, appId, m.id, { availability_status: 'taken' });
              console.log(`[${userId}] Match ${m.id} marked as taken via reply`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`[${userId}] Reply taken-detection failed: ${err.message}`);
    }
  }

  // Download attached image (if any) and upload to storage so it can be shown in the UI.
  // On linked companion devices msg.hasMedia can be false even for image messages, so
  // also trigger the download on the message type.
  let imageUrl = null;
  const isMediaMsg = msg.hasMedia || ['image', 'video', 'document', 'sticker', 'ptt', 'audio'].includes(msg.type);
  if (isMediaMsg) {
    const sess = sessions.get(userId);
    const logMedia = (type, data = {}) => {
      console.log(`[${userId}] MEDIA ${type}: ${JSON.stringify(data)}`);
      if (sess) {
        sess.eventLog = sess.eventLog || [];
        sess.eventLog.push({ type: `media_${type}`, data, ts: Date.now() });
        if (sess.eventLog.length > 80) sess.eventLog.shift();
      }
      emit('log', { type: `media_${type}`, data });
    };
    logMedia('attempt', { messageId: msg.id?._serialized, msgType: msg.type });
    // On a linked companion device the media blob isn't always ready the instant the
    // `message` event fires — downloadMedia can fail or time out. Retry a couple of
    // times with a short delay so WhatsApp has a chance to sync/decrypt it.
    let media = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !media; attempt++) {
      try {
        media = await Promise.race([
          msg.downloadMedia(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('media_download_timeout_15s')), 15000)),
        ]);
      } catch (err) {
        lastErr = err.message;
        logMedia('download_failed', { attempt, error: err.message });
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (media && media.data) {
      const mt = media.mimetype || '';
      if (mt.startsWith('image/')) {
        imageUrl = await base44Api.uploadMedia(userId, media.data, mt, media.filename || 'image.jpg');
        if (!imageUrl) logMedia('upload_failed', { mimetype: mt, size: media.data.length });
        else logMedia('uploaded', { mimetype: mt, size: media.data.length });
      } else {
        logMedia('not_image', { mimetype: mt });
      }
    } else {
      logMedia('no_media', { error: lastErr || 'empty' });
    }
  }

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
    image_url: imageUrl,
    has_image: !!imageUrl,
    received_at: new Date(msg.timestamp * 1000).toISOString(),
  });

  const wishlistItems = await base44Api.getWishlistItems(userId, apiKey, appId);
  const activeItems = wishlistItems.filter(i => i.status === 'watching');

  for (const item of activeItems) {
    const matchResult = matcher.checkMatch(content, item.keywords, item.match_mode, item.exclude_keywords);
    if (!matchResult.matched) continue;

    // Skip if we already matched this message for this wishlist item
    if (msg.id?._serialized) {
      const existing = await base44Api.findExistingMatch(userId, msg.id._serialized, item.id);
      if (existing) {
        // Backfill the image if we now have one but the existing match doesn't
        // (e.g. media download succeeds on a later rescan after auto-download was enabled)
        if (imageUrl && !existing.image_url) {
          await base44Api.updateMatch(userId, apiKey, appId, existing.id, { image_url: imageUrl });
          console.log(`[${userId}] Backfilled image for existing match ${existing.id}`);
        }
        continue;
      }
    }

    const availabilityStatus = matcher.detectAvailability(content);

    const match = await base44Api.createMatch(userId, apiKey, appId, {
      user_id: userId,
      wishlist_item_id: item.id,
      message_id: msg.id?._serialized || null,
      wishlist_item_title: item.title,
      group_name: groupName,
      sender_name: sender,
      sender_number: senderNumber,
      message_content: content,
      image_url: imageUrl,
      matched_keywords: matchResult.keywords,
      availability_status: availabilityStatus,
      notification_sent: false,
      matched_at: new Date().toISOString(),
    });

    emit('match', { match, item });

    // Don't notify about items already marked as taken
    if (availabilityStatus === 'taken') continue;

    // In-app notification — always created so the match shows up in the
    // Notifications list and triggers the in-app toast (in addition to WhatsApp).
    await base44Api.createNotification(userId, apiKey, appId, {
      user_id: userId,
      match_id: match.id,
      wishlist_item_title: item.title,
      group_name: groupName,
      message_preview: content.slice(0, 150),
      channel: 'in_app',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    // WhatsApp notification (optional) — kept in addition to the in-app one.
    if (item.notify_via_whatsapp) {
      let waStatus = 'pending';
      const userPhone = await base44Api.getUserPhone(userId, apiKey, appId);
      if (userPhone) {
        // WhatsApp JIDs must be digits only — a stored "+972..." becomes the
        // invalid "+972...@c.us" and the send silently fails. Strip non-digits.
        const cleanPhone = userPhone.replace(/[^0-9]/g, '');
        // Forward the original message (preserves its text + media) to the user,
        // preceded by a short intro so they know which wishlist item matched.
        const introMsg = `🎯 *GiveLoop Match: ${item.title}*\n📍 ${groupName}`;
        try {
          await client.sendMessage(`${cleanPhone}@c.us`, introMsg);
          await msg.forward(`${cleanPhone}@c.us`);
          waStatus = 'sent';
          await base44Api.updateMatch(userId, apiKey, appId, match.id, { notification_sent: true });
        } catch (sendErr) {
          console.error(`[${userId}] WhatsApp send/forward failed:`, sendErr.message);
          waStatus = 'failed';
        }
      }
      await base44Api.createNotification(userId, apiKey, appId, {
        user_id: userId,
        match_id: match.id,
        wishlist_item_title: item.title,
        group_name: groupName,
        message_preview: content.slice(0, 150),
        channel: 'whatsapp',
        status: waStatus,
        sent_at: new Date().toISOString(),
      });
    }
  }
}

async function syncGroupIds(userId, client, apiKey, appId, debug = {}) {
  const sess = sessions.get(userId);
  let groups = sess?.groups;
  debug.syncDebug = { hadCachedGroups: !!(groups && groups.length > 0), cachedCount: groups?.length || 0 };

  if (!groups || groups.length === 0) {
    try {
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_60s')), 60000)),
      ]).catch(err => {
        const fullErr = err?.message || String(err?.stack || err);
        console.error(`[${userId}] syncGroupIds getChats failed:`, fullErr);
        debug.syncDebug.getChatsError = fullErr;
        return [];
      });
      groups = Array.isArray(chats) ? chats.filter(c => c.isGroup) : [];
      debug.syncDebug.getChatsTotalChats = Array.isArray(chats) ? chats.length : 0;
      if (sess) sess.groups = groups;
    } catch (err) {
      debug.syncDebug.getChatsError = err.message;
      groups = [];
    }
  }

  debug.syncDebug.whatsappGroupCount = groups?.length || 0;
  debug.syncDebug.whatsappGroupNames = (groups || []).map(g => g.name);

  if (!groups || groups.length === 0) {
    console.log(`[${userId}] syncGroupIds: no WhatsApp groups available`);
    const fallback = await base44Api.getConnectedGroups(userId, apiKey, appId);
    debug.syncDebug.dbGroupCount = fallback.length;
    debug.syncDebug.dbGroups = fallback.map(g => ({ name: g.group_name, group_id: g.group_id || null }));
    return fallback;
  }

  const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
  let updated = 0;
  debug.syncDebug.dbGroupCount = monitoredGroups.length;
  debug.syncDebug.dbGroups = monitoredGroups.map(g => ({ name: g.group_name, group_id: g.group_id || null }));
  debug.syncDebug.matchAttempts = [];

  for (const mg of monitoredGroups) {
    const match = groups.find(g => g.name?.trim() === mg.group_name?.trim());
    debug.syncDebug.matchAttempts.push({
      dbName: mg.group_name,
      matched: !!match,
      waName: match?.name || null,
    });
    if (match && (!mg.group_id || mg.group_id !== match.id._serialized)) {
      await base44Api.updateConnectedGroup(userId, apiKey, appId, mg.id, { group_id: match.id._serialized });
      mg.group_id = match.id._serialized;
      updated++;
    }
  }
  debug.syncDebug.updatedCount = updated;
  console.log(`[${userId}] syncGroupIds: ${updated}/${monitoredGroups.length} groups updated`);
  return monitoredGroups;
}

// Memory-light scan: fetch only groups we already have a group_id for, via
// getChatById (one chat at a time). Avoids getChats() which loads every chat
// and OOMs the container. Used on connect. Groups without a group_id are
// skipped here and get their group_id when their next message arrives.
// Check whether a chat has been loaded into WhatsApp Web's local store WITHOUT
// triggering a load. client.getChatById uses Store.Chat.find, which awaits a
// server fetch and HANGS for chats that aren't synced yet — the #1 cause of
// getChatById timeouts right after a fresh link. Store.Chat.get is synchronous
// and returns undefined if the chat isn't loaded, so we skip unsynced chats
// instantly and only call getChatById once the chat is actually present.
async function isChatLoaded(client, chatId) {
  try {
    return await Promise.race([
      client.pupPage.evaluate((id) => {
        if (!window.Store || !window.Store.Chat) return false;
        // Iterate the in-memory models and compare serialized ids. Store.Chat.get(wid)
        // is unreliable here because Backbone keys by the model id, which is a Wid
        // object — a freshly created Wid won't match by reference, causing false
        // negatives even when the chat IS loaded. Iterating .models is cheap (no
        // deep serialization → no OOM risk, unlike getChats()).
        const arr = window.Store.Chat.getModelsArray
          ? window.Store.Chat.getModelsArray()
          : (window.Store.Chat.models || []);
        for (const c of arr) {
          const cid = c && c.id;
          if (!cid) continue;
          if (cid._serialized === id) return true;
          if (typeof cid.toString === 'function' && cid.toString() === id) return true;
        }
        return false;
      }, chatId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('check_timeout')), 15000)),
    ]);
  } catch (err) {
    console.log(`isChatLoaded check failed: ${err.message}`);
    return false;
  }
}

async function scanKnownGroups(userId, client, apiKey, appId, emit) {
  const sess = sessions.get(userId);
  try {
    const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
    const activeGroups = monitoredGroups.filter(g => g.is_active && g.group_id);
    console.log(`[${userId}] scanKnownGroups: ${activeGroups.length} groups with group_id (getChats skipped)`);
    if (sess) {
      sess.eventLog = sess.eventLog || [];
      sess.eventLog.push({ type: 'scan_known_start', data: { count: activeGroups.length, names: activeGroups.map(g => g.group_name) }, ts: Date.now() });
    }
    for (const group of activeGroups) {
      const loaded = await isChatLoaded(client, group.group_id);
      if (!loaded) {
        console.log(`[${userId}] scanKnownGroups: "${group.group_name}" not synced into store yet — skipping`);
        if (sess) sess.eventLog.push({ type: 'scan_known_not_synced', data: { name: group.group_name }, ts: Date.now() });
        continue;
      }
      try {
        const chat = await Promise.race([
          client.getChatById(group.group_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById_timeout_30s')), 30000)),
        ]);
        if (!chat) continue;
        const messages = await chat.fetchMessages({ limit: 100 });
        console.log(`[${userId}] scanKnownGroups: ${messages.length} msgs in "${group.group_name}"`);
        if (sess) sess.eventLog.push({ type: 'scan_known_group', data: { name: group.group_name, messages: messages.length }, ts: Date.now() });
        for (const msg of messages) {
          if (!msg.body && !msg.hasMedia) continue;
          await processMessage(userId, apiKey, appId, client, msg, emit, chat);
        }
      } catch (err) {
        console.log(`[${userId}] scanKnownGroups getChatById failed for "${group.group_name}": ${err.message}`);
        if (sess) sess.eventLog.push({ type: 'scan_known_group_failed', data: { name: group.group_name, error: err.message }, ts: Date.now() });
      }
    }
    if (sess) sess.eventLog.push({ type: 'scan_known_complete', data: {}, ts: Date.now() });
    console.log(`[${userId}] scanKnownGroups complete`);
  } catch (err) {
    console.error(`[${userId}] scanKnownGroups error:`, err.message);
    if (sess) sess.eventLog.push({ type: 'scan_known_error', data: { error: err.message }, ts: Date.now() });
  }
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
        const messages = await chat.fetchMessages({ limit: 100 });
        console.log(`[${userId}] Scanned ${messages.length} messages in "${group.group_name}"`);
        if (sess) { sess.eventLog.push({ type: 'scan_group', data: { name: group.group_name, messages: messages.length }, ts: Date.now() }); }
        for (const msg of messages) {
          if (!msg.body && !msg.hasMedia) continue;
          await processMessage(userId, apiKey, appId, client, msg, emit, chat);
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
  if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
  try {
    await session.client.destroy();
  } catch (_) {}
  sessions.delete(userId);
  // Wait for Chromium to fully release file handles before clearing — if we
  // try to rm the profile dir immediately, the SingletonLock file is still held
  // and the rmdir fails with ENOTEMPTY, leaving the stale profile that causes
  // "The browser is already running" on the next launch.
  await new Promise(r => setTimeout(r, 2000));
  // Also clear stale local session files (auth + Chromium profile) so they
  // don't interfere with the next link
  await clearSessionFiles(userId);
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

// Wait for an initializing/restoring session to settle into a terminal state.
function waitForSessionReady(userId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const s = sessions.get(userId);
      if (!s) { clearInterval(interval); resolve('gone'); return; }
      if (s.status === 'connected') { clearInterval(interval); resolve('connected'); return; }
      if (s.status === 'pending_qr') { clearInterval(interval); resolve('pending_qr'); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve('timeout'); return; }
    }, 2000);
  });
}

async function rescanMessages(userId, apiKey, appId) {
  if (!sessions.has(userId)) {
    // Server restarted (redeploy/OOM) wiped the in-memory session. Try to
    // restore from the saved session_data first — if the WhatsApp link is
    // still valid server-side, this reconnects WITHOUT a new QR scan. Only
    // fresh-start (new QR) if the restore fails or the session expired.
    console.log(`[${userId}] Rescan: no active session — attempting restore from DB`);
    startSession(userId, apiKey, appId, () => {}, { freshStart: false, authToken: apiKey });
    const settled = await waitForSessionReady(userId, 60000);
    if (settled === 'connected') {
      console.log(`[${userId}] Rescan: restore succeeded — reconnected without QR`);
    } else if (settled === 'pending_qr') {
      return { reconnecting: true, message: 'Your previous WhatsApp session expired. Open the Connect page to scan the new QR, then try Rescan again.' };
    } else {
      console.log(`[${userId}] Rescan: restore failed (${settled}) — forcing fresh restart`);
      startSession(userId, apiKey, appId, () => {}, { freshStart: true, authToken: apiKey });
      return { reconnecting: true, message: 'No active WhatsApp session and restore failed. Starting fresh — open the Connect page to scan the new QR in ~30s, then try Rescan once connected.' };
    }
  }
  const session = sessions.get(userId);
  if (session.status !== 'connected') {
    if (session.status === 'initializing' || session.status === 'restoring') {
      // Wait for the session to finish starting up, then proceed if it connects
      const settled = await waitForSessionReady(userId, 45000);
      if (settled === 'pending_qr') {
        return { reconnecting: true, message: 'Session needs a QR scan — open the Connect page to scan it, then try Rescan again.' };
      }
      if (settled !== 'connected') {
        // Still stuck after 45s — force a fresh restart so a new QR is generated
        console.log(`[${userId}] Rescan: still ${session.status} after 45s — forcing fresh restart`);
        try { await session.client?.destroy(); } catch (_) {}
        sessions.delete(userId);
        clearSessionFiles(userId);
        await new Promise(r => setTimeout(r, 3000));
        startSession(userId, apiKey, appId, () => {}, { freshStart: true, authToken: apiKey });
        return { reconnecting: true, message: 'Session was stuck initializing. Restarting fresh — open the Connect page to scan the new QR in ~30s.' };
      }
    } else {
      return { error: 'not_connected', status: session.status };
    }
  }
  let scanned = 0;
  let skipped = 0;
  const wwebEvent = (session.eventLog || []).find(e => e.type === 'wweb_version');
  const debug = { hasToken: true, hasAppId: !!appId, appIdValue: appId, userId, wwebVersion: wwebEvent?.data?.version || null };

  // Verify the WhatsApp client is actually alive before doing anything else.
  // "ready" may have fired but the Chromium page can still be unresponsive.
  try {
    const state = await Promise.race([
      session.client.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getState_timeout_15s')), 15000)),
    ]);
    debug.connectionState = state;
    console.log(`[${userId}] Rescan: client state = ${state}`);
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_state_check', data: { state }, ts: Date.now() }); }
  } catch (stateErr) {
    const fullErr = stateErr?.message || String(stateErr);
    debug.connectionState = `ERROR: ${fullErr}`;
    console.error(`[${userId}] Rescan: getState failed — session is dead: ${fullErr}`);
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_state_failed', data: { error: fullErr }, ts: Date.now() }); }
    // Session is dead — restart fresh immediately
    try { await session.client?.destroy(); } catch (_) {}
    sessions.delete(userId);
    await clearSessionFiles(userId);
    await new Promise(r => setTimeout(r, 3000));
    startSession(userId, apiKey, appId, () => {}, { freshStart: true, authToken: apiKey });
    return { reconnecting: true, message: `WhatsApp client is unresponsive (getState failed: ${fullErr.slice(0, 80)}). Restarting fresh — wait ~30s then try again.`, debug };
  }

  // Diagnostic via SDK
  try {
    const allGroups = await base44Api.listAllConnectedGroups(userId);
    debug.rawAll = { count: allGroups.length, sample: allGroups.length > 0 ? { id: allGroups[0].id, name: allGroups[0].group_name, user_id: allGroups[0].user_id } : null };
  } catch (rawErr) {
    debug.rawApiError = { message: rawErr.message };
  }
  try {
    // Read monitored groups straight from the DB. We intentionally do NOT call
    // syncGroupIds()/getChats() here — loading every chat OOMs the Railway
    // container and restarts it (wiping the session). Groups without a stored
    // group_id are skipped; they get one when their next message arrives.
    const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
    console.log(`[${userId}] Rescan: ${monitoredGroups.length} monitored groups (getChats skipped to avoid OOM), appId=${appId}`);
    debug.groupsReturned = monitoredGroups.length;
    debug.getChatsSkipped = true;
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_groups_loaded', data: { total: monitoredGroups.length, names: monitoredGroups.map(g => g.group_name) }, ts: Date.now() }); }
    const activeGroups = monitoredGroups.filter(g => g.is_active);
    console.log(`[${userId}] Rescan: ${activeGroups.length} active groups`);
    if (session.eventLog) { session.eventLog.push({ type: 'rescan_start', data: { activeGroups: activeGroups.length, names: activeGroups.map(g => g.group_name) }, ts: Date.now() }); }

    debug.rescanGroups = [];
    for (const group of activeGroups) {
      if (!group.group_id) {
        console.log(`[${userId}] Rescan: "${group.group_name}" has no group_id — skipping`);
        skipped++;
        debug.rescanGroups.push({ name: group.group_name, skipped: true, reason: 'no_group_id' });
        continue;
      }
      try {
        // getChatById triggers a server sync for chats not yet in the local store.
        // On a freshly linked companion the group may not be synced yet — calling
        // getChatById forces WhatsApp to fetch it (this works now that the Web version
        // is pinned correctly; the old "hang" was the version-mismatch "r" error).
        // Bounded by 60s so an unsynced chat can't stall the rescan forever.
        const chat = await Promise.race([
          session.client.getChatById(group.group_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById_timeout_60s')), 60000)),
        ]);
        const messages = await chat.fetchMessages({ limit: 100 });
        const msgCount = messages.length;
        console.log(`[${userId}] Rescan: ${msgCount} msgs in "${group.group_name}"`);
        if (session.eventLog) { session.eventLog.push({ type: 'rescan_group', data: { name: group.group_name, messages: msgCount }, ts: Date.now() }); }
        let processed = 0;
        for (const msg of messages) {
          if (!msg.body && !msg.hasMedia) continue;
          await processMessage(userId, apiKey, appId, session.client, msg, () => {}, chat);
          scanned++;
          processed++;
        }
        debug.rescanGroups.push({ name: group.group_name, group_id: group.group_id, totalMsgs: msgCount, processed, scanned });
      } catch (err) {
        const isTimeout = typeof err.message === 'string' && err.message.includes('timeout');
        console.log(`[${userId}] Rescan: getChatById ${isTimeout ? 'timed out (chat not synced yet)' : 'failed'} for "${group.group_name}": ${err.message}`);
        if (session.eventLog) { session.eventLog.push({ type: isTimeout ? 'rescan_group_not_synced' : 'rescan_group_failed', data: { name: group.group_name, error: err.message }, ts: Date.now() }); }
        debug.rescanGroups.push({ name: group.group_name, group_id: group.group_id, notSynced: isTimeout, error: err.message });
      }
    }
    // Auto-recover: if every group with a group_id failed, the underlying Chromium page
    // is likely dead even though the client thinks it's "connected". BUT a getChatById
    // timeout right after a fresh link just means WhatsApp is still syncing chats — that
    // is NOT a dead session, and restarting it forces an unnecessary new QR scan. Only
    // restart on real errors (Target closed, navigation, etc.); on pure timeouts, tell
    // the user to wait and retry.
    const groupsWithId = (debug.rescanGroups || []).filter(g => g.group_id);
    // Chats not yet synced into the local store — getChatById would hang waiting
    // for them. The session is fine, so don't restart; just tell the user to retry.
    const notSyncedCount = (debug.rescanGroups || []).filter(g => g.notSynced).length;
    if (scanned === 0 && notSyncedCount > 0) {
      console.log(`[${userId}] Rescan: ${notSyncedCount} group(s) still syncing into store — not restarting`);
      if (session.eventLog) { session.eventLog.push({ type: 'rescan_still_syncing', data: { groups: notSyncedCount }, ts: Date.now() }); }
      return { syncing: true, message: `WhatsApp is linked and real-time monitoring is already active — you'll be alerted the instant a new matching message arrives. The group's history hasn't synced to this linked device yet (WhatsApp controls companion-device sync, and getChatById hangs until it does). To trigger the sync now, send any message into the group from your phone — that forces the linked device to load the chat — then click Rescan again to backfill recent messages.`, debug };
    }
    const allFailed = groupsWithId.length > 0 && groupsWithId.every(g => g.error);
    if (allFailed && scanned === 0) {
      const errors = groupsWithId.map(g => g.error).join('; ');
      const allTimeouts = groupsWithId.every(g => typeof g.error === 'string' && g.error.includes('timeout'));
      if (allTimeouts) {
        console.log(`[${userId}] All ${groupsWithId.length} groups timed out — WhatsApp still syncing, NOT restarting`);
        if (session.eventLog) { session.eventLog.push({ type: 'rescan_still_syncing', data: { groups: groupsWithId.length }, ts: Date.now() }); }
        return { syncing: true, message: `WhatsApp is still syncing chats after the fresh link. Wait ~60s, then click Rescan again.`, debug };
      }
      console.log(`[${userId}] All ${groupsWithId.length} groups failed — session is functionally dead, forcing fresh restart. Errors: ${errors}`);
      if (session.eventLog) { session.eventLog.push({ type: 'dead_session_recover', data: { groups: groupsWithId.length, errors }, ts: Date.now() }); }
      try { await session.client?.destroy(); } catch (_) {}
      sessions.delete(userId);
      clearSessionFiles(userId);
      // Wait for Chromium to fully exit before starting a new instance
      await new Promise(r => setTimeout(r, 3000));
      startSession(userId, apiKey, appId, () => {}, { freshStart: true, authToken: apiKey });
      return { reconnecting: true, message: `WhatsApp connection is dead (all ${groupsWithId.length} groups failed: ${errors.slice(0, 100)}). Restarting fresh — wait ~30s then try again.`, debug };
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

// Lightweight group listing — reads the in-memory WhatsApp Web store directly
// via pupPage.evaluate instead of calling getChats(). getChats() loads every
// chat + message history into memory, which OOMs the Railway container and
// kills the session. The store-based approach is synchronous (no server fetch)
// and only serializes the group names + ids we need.
async function getGroups(userId) {
  if (!sessions.has(userId)) return { error: 'no_active_session' };
  const session = sessions.get(userId);
  if (session.status !== 'connected' || !session.client) return { error: 'not_connected', status: session.status };
  try {
    const groups = await Promise.race([
      session.client.pupPage.evaluate(() => {
        if (!window.Store || !window.Store.Chat) return [];
        const arr = window.Store.Chat.getModelsArray
          ? window.Store.Chat.getModelsArray()
          : (window.Store.Chat.models || []);
        const result = [];
        for (const c of arr) {
          if (!c || !c.isGroup) continue;
          const cid = c.id;
          const serialized = cid?._serialized || (typeof cid?.toString === 'function' ? cid.toString() : null);
          if (serialized && c.name) result.push({ name: c.name, id: serialized });
        }
        return result;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getGroups_store_timeout_30s')), 30000)),
    ]);
    return { groups };
  } catch (err) {
    // If the store is empty (freshly linked, chats not synced yet), fall back
    // to getChats() but with a tight timeout. This is a last resort — it may
    // OOM on accounts with many chats, but it's better than returning nothing
    // for users whose chats ARE synced.
    if (String(err.message).includes('timeout') || String(err.message).includes('Target closed')) {
      session.status = 'disconnected';
      return { error: 'not_connected', detail: err.message };
    }
    try {
      const chats = await Promise.race([
        session.client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getChats_timeout_30s')), 30000)),
      ]);
      if (!Array.isArray(chats)) return { error: 'getChats_failed' };
      const fallbackGroups = chats.filter(c => c.isGroup).map(c => ({ name: c.name, id: c.id._serialized }));
      return { groups: fallbackGroups };
    } catch (fallbackErr) {
      session.status = 'disconnected';
      return { error: 'not_connected', detail: fallbackErr.message };
    }
  }
}

// Validate that a group name exists in the user's WhatsApp account, and suggest
// similar names if it doesn't. Used by the Add Group flow so users don't monitor
// a group that isn't actually on their account.
async function validateGroup(userId, groupName) {
  if (!sessions.has(userId)) return { error: 'no_active_session' };
  const session = sessions.get(userId);
  if (session.status !== 'connected' || !session.client) return { error: 'not_connected', status: session.status };
  // Use the lightweight store-based approach to avoid OOM from getChats()
  let groups;
  try {
    groups = await Promise.race([
      session.client.pupPage.evaluate(() => {
        if (!window.Store || !window.Store.Chat) return [];
        const arr = window.Store.Chat.getModelsArray
          ? window.Store.Chat.getModelsArray()
          : (window.Store.Chat.models || []);
        const result = [];
        for (const c of arr) {
          if (!c || !c.isGroup) continue;
          const cid = c.id;
          const serialized = cid?._serialized || (typeof cid?.toString === 'function' ? cid.toString() : null);
          if (serialized && c.name) result.push({ name: c.name, id: serialized });
        }
        return result;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('store_timeout_30s')), 30000)),
    ]);
  } catch (err) {
    return { error: String(err.message).includes('timeout') ? 'not_connected' : err.message };
  }
  const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(groupName);
  if (!target) return { error: 'empty_name' };
  const exact = groups.find(g => norm(g.name) === target);
  if (exact) return { exists: true, match: exact };
  const targetTokens = new Set(target.split(' ').filter(t => t.length > 1));
  const scored = groups.map(g => {
    const n = norm(g.name);
    let score = 0;
    if (n.includes(target) || target.includes(n)) score += 5;
    const gTokens = new Set(n.split(' ').filter(t => t.length > 1));
    for (const t of targetTokens) if (gTokens.has(t)) score += 2;
    return { name: g.name, id: g.id, score };
  }).filter(g => g.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  return { exists: false, suggestions: scored };
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

module.exports = { startSession, disconnectSession, getStatus, getSessionCount, autoReconnect, reconnectWithToken, verifyConnection, getDiagnostics, rescanMessages, getGroups, validateGroup, saveSessionToDb };
