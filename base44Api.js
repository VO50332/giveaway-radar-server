/* eslint-env node */
/* eslint-disable no-undef */
const axios = require('axios');

const BASE_URL = 'https://api.base44.com/api/apps';

function getHeaders(apiKey) {
  return {
    'api-key': apiKey,
    'Content-Type': 'application/json',
  };
}

function client(apiKey, appId) {
  const base = `${BASE_URL}/${appId}/entities`;
  const headers = getHeaders(apiKey);

  return {
    async list(entity, filter = {}) {
      const params = Object.keys(filter).length ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
      const res = await axios.get(`${base}/${entity}${params}`, { headers });
      return res.data;
    },
    async create(entity, data) {
      const res = await axios.post(`${base}/${entity}`, data, { headers });
      return res.data;
    },
    async update(entity, id, data) {
      const res = await axios.put(`${base}/${entity}/${id}`, data, { headers });
      return res.data;
    },
  };
}

async function updateSession(userId, apiKey, appId, updates) {
  try {
    const api = client(apiKey, appId);
    const sessions = await api.list('WhatsAppSession', { user_id: userId });
    if (sessions.length > 0) {
      console.log('updateSession: updating', sessions[0].id, 'with keys:', Object.keys(updates));
      const result = await api.update('WhatsAppSession', sessions[0].id, updates);
      console.log('updateSession: success');
      return result;
    } else {
      console.error('updateSession: no session found for user', userId);
    }
  } catch (err) {
    console.error('updateSession error:', err.response?.status, err.response?.data || err.message);
  }
}

async function getConnectedGroups(userId, apiKey, appId) {
  try {
    const api = client(apiKey, appId);
    const result = await api.list('ConnectedGroup', { user_id: userId });
    console.log(`getConnectedGroups: userId=${userId}, found ${result.length} groups`);
    return result;
  } catch (err) {
    console.error(`getConnectedGroups error: userId=${userId}, status=${err.response?.status}, msg=${err.message}`);
    return [];
  }
}

async function getWishlistItems(userId, apiKey, appId) {
  try {
    const api = client(apiKey, appId);
    return await api.list('WishlistItem', { user_id: userId });
  } catch {
    return [];
  }
}

async function createGroupMessage(userId, apiKey, appId, data) {
  try {
    const api = client(apiKey, appId);
    return await api.create('GroupMessage', data);
  } catch (err) {
    console.error('createGroupMessage error:', err.message);
  }
}

async function createMatch(userId, apiKey, appId, data) {
  try {
    const api = client(apiKey, appId);
    return await api.create('Match', data);
  } catch (err) {
    console.error('createMatch error:', err.message);
    return null;
  }
}

async function createNotification(userId, apiKey, appId, data) {
  try {
    const api = client(apiKey, appId);
    return await api.create('Notification', data);
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

async function updateConnectedGroup(apiKey, appId, groupId, updates) {
  try {
    const api = client(apiKey, appId);
    return await api.update('ConnectedGroup', groupId, updates);
  } catch (err) {
    console.error('updateConnectedGroup error:', err.message);
  }
}

async function getUserPhone(userId, apiKey, appId) {
  try {
    const api = client(apiKey, appId);
    const sessions = await api.list('WhatsAppSession', { user_id: userId });
    return sessions[0]?.phone_number || null;
  } catch {
    return null;
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
};
