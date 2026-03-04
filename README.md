# 👑 LOYALTY MD - Session Generator

Generate a Session ID for your LOYALTY MD WhatsApp bot.

## 🚀 One-Click Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/INSANEFF/LOYALTY-MD-SESSION)

### After deploying:
1. Open your Render dashboard → **Environment** tab
2. Add `MONGODB_URI` = your MongoDB connection string (optional)
3. Visit your Render URL (e.g. `https://loyalty-md-session.onrender.com`)
4. Enter your WhatsApp number → get pairing code → enter on phone
5. Copy the `SESSION_ID` and set it in your bot's hosting panel

## 💻 Local Usage

```bash
# Clone and install
git clone https://github.com/INSANEFF/LOYALTY-MD-SESSION.git
cd LOYALTY-MD-SESSION
npm install

# Run locally
node api/index.js
# Open http://localhost:3000
```

## 🔑 Using the Session ID

Set `SESSION_ID` as an environment variable in your bot hosting:

```
SESSION_ID=LOYALTY-MD~eyJub2lzZUtleS...
```

The bot will decode it automatically and connect.

## ⚠️ Important

- **Do NOT deploy on Vercel** — serverless functions kill WebSocket connections
- Use **Render.com** (free), Railway, or any persistent server
- The session generator needs to stay alive for ~60 seconds while you pair

---

Powered by **LOYALTY MD** 👑
