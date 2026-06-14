# GiveAway Radar — Backend Server

This Node.js server handles WhatsApp Web sessions for all users and writes matches back to the Base44 app database.

---

## 🚀 Deploy to Railway (easiest, free tier available)

1. Go to [railway.app](https://railway.app) and create a free account
2. Click **New Project → Deploy from GitHub**
3. Push the `server/` folder to a GitHub repo
4. Set environment variables (none required — credentials are passed per-request)
5. Railway auto-detects Node.js and runs `npm start`

---

## 🖥️ Deploy to VPS (Hetzner / DigitalOcean)

```bash
# 1. SSH into your server
ssh root@YOUR_SERVER_IP

# 2. Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 3. Install Chromium (required by whatsapp-web.js)
apt-get install -y chromium-browser

# 4. Clone your repo or upload the server/ folder
git clone https://github.com/YOUR_USERNAME/giveaway-radar-server.git
cd giveaway-radar-server

# 5. Install dependencies
npm install

# 6. Run with PM2 (keeps it alive forever)
npm install -g pm2
pm2 start index.js --name giveaway-radar
pm2 save
pm2 startup
```

---

## 🔗 Connect to the Base44 App

Once deployed, copy your server URL (e.g. `https://giveaway-radar.railway.app`) and paste it into the **Connect WhatsApp** page in the app.

The app will:
1. Call `POST /session/start` with your `userId`, `apiKey`, and `appId`
2. Receive a QR code via WebSocket
3. Once you scan it, the server monitors your groups 24/7

---

## 📡 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| POST | `/session/start` | Start a WhatsApp session |
| POST | `/session/disconnect` | Disconnect a session |
| GET | `/session/status/:userId` | Get session status |

---

## ⚙️ How it works

1. User enters server URL in the app
2. App calls `/session/start` → server spawns a WhatsApp Web client
3. QR code is streamed back via WebSocket
4. User scans QR with their phone
5. Server listens to all group messages 24/7
6. Each message is checked against the user's wishlist keywords
7. Matches are written directly to Base44 database
8. User gets a WhatsApp notification for each match