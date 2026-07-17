/* eslint-env node */
/* eslint-disable no-undef */
// Uses the official @base44/sdk with a user JWT token passed from the frontend.
// No email/password needed — the token comes from the user's authenticated app session.
// Tokens are stored in memory per-user; on server restart, users re-send their token
// from the app (happens automatically when they open the Connect WhatsApp page).

let _sdkModule = null;

async function loadSdk() {
  if (!_sdkModule) {
    _sdkModule = await import('@base44/sdk');
  }
  return _sdkModule;
}

// Per-user token storage (in memory — cleared on server restart)
const _userTokens = new Map();

function setUserToken(userId, token) {
  if (userId && token) {
    _userTokens.set(userId, token);
  }
}

// Per-token client cache
const _clientCache = new Map(); // token -> { client, createdAt }
const TOKEN_TTL_MS = 45 * 60 * 1000;

async function getClient(userId) {
  const token = _userTokens.get(userId);
  if (!token) {
    throw new Error(`No auth token for user ${userId}. Open the app to refresh.`);
  }

  const appId = process.env.BASE44_APP_ID;
  if (!appId) {
    throw new Error('Missing BASE44_APP_ID env var');
  }

  const now = Date.now();
  const cached = _clientCache.get(token);
  if (cached && (now - cached.createdAt) < TOKEN_TTL_MS) {
    return cached.client;
  }

  const { createClient } = await loadSdk();
  const client = createClient({ appId, token });
  _clientCache.set(token, { client, createdAt: now });
  console.log(`[base44Api] Created client for user ${userId}`);
  return client;
}

async function updateSession(userId, _apiKey, _appId, updates) {
  try {
    const client = await getClient(userId);
    const sessions = await client.entities.WhatsAppSession.filter({ user_id: userId });
    if (sessions.length > 0) {
      console.log('updateSession: updating', sessions[0].id, 'with keys:', Object.keys(updates));
      const result = await client.entities.WhatsAppSession.update(sessions[0].id, updates);
      console.log('updateSession: success');
      return result;
    } else {
      console.error('updateSession: no session found for user', userId);
    }
  } catch (err) {
    console.error('updateSession error:', err.message);
  }
}

async function getConnectedGroups(userId) {
  try {
    const client = await getClient(userId);
    const result = await client.entities.ConnectedGroup.filter({ user_id: userId });
    console.log(`getConnectedGroups: userId=${userId}, found ${result.length} groups`);
    return result;
  } catch (err) {
    console.error(`getConnectedGroups error: userId=${userId}, msg=${err.message}`);
    return [];
  }
}

async function getWishlistItems(userId) {
  try {
    const client = await getClient(userId);
    return await client.entities.WishlistItem.filter({ user_id: userId });
  } catch (err) {
    console.error('getWishlistItems error:', err.message);
    return [];
  }
}

async function createGroupMessage(userId, _apiKey, _appId, data) {
  try {
    const client = await getClient(userId);
    return await client.entities.GroupMessage.create(data);
  } catch (err) {
    console.error('createGroupMessage error:', err.message);
  }
}

async function createMatch(userId, _apiKey, _appId, data) {
  try {
    const client = await getClient(userId);
    return await client.entities.Match.create(data);
  } catch (err) {
    console.error('createMatch error:', err.message);
    return null;
  }
}

async function updateMatch(userId, _apiKey, _appId, matchId, updates) {
  try {
    const client = await getClient(userId);
    return await client.entities.Match.update(matchId, updates);
  } catch (err) {
    console.error('updateMatch error:', err.message);
  }
}

async function createNotification(userId, _apiKey, _appId, data) {
  try {
    const client = await getClient(userId);
    return await client.entities.Notification.create(data);
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

async function updateConnectedGroup(userId, _apiKey, _appId, groupId, updates) {
  try {
    const client = await getClient(userId);
    return await client.entities.ConnectedGroup.update(groupId, updates);
  } catch (err) {
    console.error('updateConnectedGroup error:', err.message);
  }
}

async function findExistingMatch(userId, messageId, wishlistItemId) {
  try {
    const client = await getClient(userId);
    const existing = await client.entities.Match.filter({
      user_id: userId,
      message_id: messageId,
      wishlist_item_id: wishlistItemId,
    });
    return existing.length > 0 ? existing[0] : null;
  } catch (err) {
    console.error('findExistingMatch error:', err.message);
    return null;
  }
}

async function getUserPhone(userId) {
  try {
    const client = await getClient(userId);
    const sessions = await client.entities.WhatsAppSession.filter({ user_id: userId });
    return sessions[0]?.phone_number || null;
  } catch {
    return null;
  }
}

async function listWhatsAppSessions(userId, _apiKey, _appId, filter) {
  try {
    const client = await getClient(userId);
    return await client.entities.WhatsAppSession.filter(filter || {});
  } catch (err) {
    console.error('listWhatsAppSessions error:', err.message);
    return [];
  }
}

async function getWhatsAppSession(userId) {
  try {
    const client = await getClient(userId);
    const sessions = await client.entities.WhatsAppSession.filter({ user_id: userId });
    return sessions[0] || null;
  } catch (err) {
    console.error('getWhatsAppSession error:', err.message);
    return null;
  }
}

async function uploadMedia(userId, base64Data, mimetype, filename) {
  try {
    const client = await getClient(userId);
    const buffer = Buffer.from(base64Data, 'base64');
    const file = new Blob([buffer], { type: mimetype || 'image/jpeg' });
    const result = await client.integrations.Core.UploadFile({ file, filename });
    return result.file_url || null;
  } catch (err) {
    console.error('uploadMedia error:', err.message);
    return null;
  }
}

async function listAllConnectedGroups(userId) {
  try {
    const client = await getClient(userId);
    return await client.entities.ConnectedGroup.list();
  } catch (err) {
    console.error('listAllConnectedGroups error:', err.message);
    return [];
  }
}

async function runApiDiagnostic(userId, token) {
  const result = {
    hasToken: !!token,
    userId,
    authError: null,
    rawFiltered: null,
    rawAll: null,
    rawApiError: null,
  };
  try {
    if (token) setUserToken(userId, token);
    const client = await getClient(userId);
    const filtered = await client.entities.ConnectedGroup.filter({ user_id: userId });
    result.rawFiltered = {
      count: filtered.length,
      sample: filtered.length > 0
        ? { id: filtered[0].id, name: filtered[0].group_name, user_id: filtered[0].user_id }
        : null,
    };
    const all = await client.entities.ConnectedGroup.list();
    result.rawAll = {
      count: all.length,
      sample: all.length > 0
        ? { id: all[0].id, name: all[0].group_name, user_id: all[0].user_id }
        : null,
    };
  } catch (err) {
    result.rawApiError = { message: err.message };
  }
  return result;
}

module.exports = {
  setUserToken,
  updateSession,
  getConnectedGroups,
  getWishlistItems,
  createGroupMessage,
  createMatch,
  createNotification,
  getUserPhone,
  updateConnectedGroup,
  findExistingMatch,
  updateMatch,
  listWhatsAppSessions,
  getWhatsAppSession,
  listAllConnectedGroups,
  runApiDiagnostic,
  uploadMedia,
};
