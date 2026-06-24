/* eslint-env node */
/* eslint-disable no-undef */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const base44Api = require('./base44Api');
const matcher = require('./matcher');

// Map of userId -> { client, status, apiKey, appId }
const sessions = new Map();

async function startSession(userId, apiKey, appId, emit) {
  // If session already exists and is connected, return
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === 'connected') {
      return { status: 'already_connected' };
    }
    // Destroy old session before recreating
    await destroySession(userId);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    },
  });

  sessions.set(userId, { client, status: 'initializing', apiKey, appId });

  client.on('qr', async (qr) => {
    const sess = sessions.get(userId);
    sess.status = 'pending_qr';
    sess.qr = qr;  // store in memory for direct retrieval
    emit('qr', { qr });
    console.log(`[${userId}] QR generated (length: ${qr.length})`);
    // Also try saving to DB (best-effort)
    await base44Api.updateSession(userId, apiKey, appId, { status: 'pending_qr', qr_code: qr });
  });

  client.on('ready', async () => {
    const session = sessions.get(userId);
    session.status = 'connected';
    emit('ready', { status: 'connected' });
    await base44Api.updateSession(userId, apiKey, appId, { status: 'connected', qr_code: null });
    console.log(`[${userId}] WhatsApp connected`);

    // Load groups and update DB
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    session.groups = groups;
    emit('groups', { count: groups.length });
  });

  client.on('message', async (msg) => {
    const session = sessions.get(userId);
    if (!session) return;

    // Only process group messages
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const groupName = chat.name;
    const content = msg.body || '';
    const sender = msg.author || msg.from;

    // Check if this group is monitored
    const monitoredGroups = await base44Api.getConnectedGroups(userId, apiKey, appId);
    const isMonitored = monitoredGroups.some(g => g.group_name === groupName && g.is_active);
    if (!isMonitored) return;

    // Save message to DB
    await base44Api.createGroupMessage(userId, apiKey, appId, {
      user_id: userId,
      group_id: chat.id._serialized,
      group_name: groupName,
      message_id: msg.id._serialized,
      sender_name: sender,
      content,
      received_at: new Date().toISOString(),
    });

    // Get wishlist items and check for matches
    const wishlistItems = await base44Api.getWishlistItems(userId, apiKey, appId);
    const activeItems = wishlistItems.filter(i => i.status === 'watching');

    for (const item of activeItems) {
      const matchResult = matcher.checkMatch(content, item.keywords);
      if (!matchResult.matched) continue;

      const availabilityStatus = matcher.detectAvailability(content);

      // Save match
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

      // Send WhatsApp notification back to the user
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
  });

  client.on('disconnected', async (reason) => {
    console.log(`[${userId}] Disconnected: ${reason}`);
    if (sessions.has(userId)) {
      sessions.get(userId).status = 'disconnected';
    }
    emit('disconnected', { reason });
    await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });

  client.on('auth_failure', async (msg) => {
    console.error(`[${userId}] Auth failure: ${msg}`);
    await base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });

  client.initialize().catch(err => {
    console.error(`[${userId}] client.initialize() failed:`, err.message);
    base44Api.updateSession(userId, apiKey, appId, { status: 'disconnected' });
  });
  return { status: 'initializing' };
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
}

function getStatus(userId) {
  if (!sessions.has(userId)) return { status: 'not_started' };
  const s = sessions.get(userId);
  return { status: s.status, qr: s.qr || null };
}

function getSessionCount() {
  return sessions.size;
}

module.exports = { startSession, disconnectSession, getStatus, getSessionCount };
