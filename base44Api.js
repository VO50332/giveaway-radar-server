/* eslint-env node */
/* eslint-disable no-undef */
// Uses the official @base44/sdk instead of raw axios calls.
// The old URL (https://api.base44.com/api/apps/...) returned Wix 404 pages.

let _sdkModule = null;

async function loadSdk() {
  if (!_sdkModule) {
    _sdkModule = await import('@base44/sdk');
  }
  return _sdkModule;
}

const _clientCache = new Map();

async function getClient(apiKey, appId) {
  const cacheKey = `${apiKey}:${appId}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);
  const { createClient } = await loadSdk();
  const client = createClient({ appId, token: apiKey });
  _clientCache.set(cacheKey, client);
  return client;
}

async function updateSession(userId, apiKey, appId, updates) {
  try {
    const client = await getClient(apiKey, appId);
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

async function getConnectedGroups(userId, apiKey, appId) {
  try {
    const client = await getClient(apiKey, appId);
    const result = await client.entities.ConnectedGroup.filter({ user_id: userId });
    console.log(`getConnectedGroups: userId=${userId}, found ${result.length} groups`);
    return result;
  } catch (err) {
    console.error(`getConnectedGroups error: userId=${userId}, msg=${err.message}`);
    return [];
  }
}

async function getWishlistItems(userId, apiKey, appId) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.WishlistItem.filter({ user_id: userId });
  } catch (err) {
    console.error('getWishlistItems error:', err.message);
    return [];
  }
}

async function createGroupMessage(userId, apiKey, appId, data) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.GroupMessage.create(data);
  } catch (err) {
    console.error('createGroupMessage error:', err.message);
  }
}

async function createMatch(userId, apiKey, appId, data) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.Match.create(data);
  } catch (err) {
    console.error('createMatch error:', err.message);
    return null;
  }
}

async function createNotification(userId, apiKey, appId, data) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.Notification.create(data);
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

async function updateConnectedGroup(apiKey, appId, groupId, updates) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.ConnectedGroup.update(groupId, updates);
  } catch (err) {
    console.error('updateConnectedGroup error:', err.message);
  }
}

async function getUserPhone(userId, apiKey, appId) {
  try {
    const client = await getClient(apiKey, appId);
    const sessions = await client.entities.WhatsAppSession.filter({ user_id: userId });
    return sessions[0]?.phone_number || null;
  } catch {
    return null;
  }
}

async function listWhatsAppSessions(apiKey, appId, filter) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.WhatsAppSession.filter(filter);
  } catch (err) {
    console.error('listWhatsAppSessions error:', err.message);
    return [];
  }
}

async function getWhatsAppSession(userId, apiKey, appId) {
  try {
    const client = await getClient(apiKey, appId);
    const sessions = await client.entities.WhatsAppSession.filter({ user_id: userId });
    return sessions[0] || null;
  } catch (err) {
    console.error('getWhatsAppSession error:', err.message);
    return null;
  }
}

async function listAllConnectedGroups(apiKey, appId) {
  try {
    const client = await getClient(apiKey, appId);
    return await client.entities.ConnectedGroup.list();
  } catch (err) {
    console.error('listAllConnectedGroups error:', err.message);
    return [];
  }
}

module.exports = {
  updateSession,
  getConnectedGroups,
  getWishlistItems,
  createGroupMessage,
  createMatch,
  createNotification,
  getUserPhone,
  updateConnectedGroup,
  listWhatsAppSessions,
  getWhatsAppSession,
  listAllConnectedGroups,
};
