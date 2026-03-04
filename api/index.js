/*
  LOYALTY MD Session Generator API
  
  ⚠️ This needs a PERSISTENT server (Render, Railway, VPS).
  Vercel serverless CANNOT keep WebSocket connections alive.
  
  Deploy on Render.com (free):
    - New Web Service → Connect GitHub repo
    - Build Command: npm install
    - Start Command: node api/index.js
    - Set MONGODB_URI env var (optional)
*/

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory store for active pairing requests and sockets
const pairingRequests = {};
const activeSockets = {};

// MongoDB connection
let db = null;
async function getDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  try {
    const client = new MongoClient(uri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000
    });
    await client.connect();
    db = client.db('loyaltymd');
    console.log('[DB] Connected to MongoDB');
    return db;
  } catch (err) {
    console.error('[DB] MongoDB connection failed:', err.message);
    return null;
  }
}

/**
 * POST /api/pair
 * Body: { phone: "1234567890" }
 * Returns: { success, requestId, pairingCode }
 */
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.length < 7) {
      return res.json({ success: false, error: 'Invalid phone number.' });
    }

    const cleanNumber = phone.replace(/[^0-9]/g, '');
    const requestId = `pair_${cleanNumber}_${Date.now()}`;
    const tempDir = path.join(os.tmpdir(), 'loyalty-sessions', requestId);
    fs.mkdirSync(tempDir, { recursive: true });

    pairingRequests[requestId] = { status: 'initializing', phone: cleanNumber };

    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }).child({ level: 'silent' }))
      },
      browser: ["Ubuntu", "Chrome", "20.0.00"]
    });

    // Keep reference so it doesn't get GC'd
    activeSockets[requestId] = sock;

    sock.ev.on('creds.update', saveCreds);

    // Listen for connection events
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      try {
        if (connection === 'open') {
          console.log(`[PAIR] ${requestId} connected!`);
          
          const credsPath = path.join(tempDir, 'creds.json');
          if (!fs.existsSync(credsPath)) {
            pairingRequests[requestId] = { status: 'error', error: 'Credentials file not found.' };
            return;
          }
          
          const credsData = fs.readFileSync(credsPath, 'utf8');
          const sessionId = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;

          // Save to MongoDB if available
          try {
            const database = await getDB();
            if (database) {
              const sessionName = `session_${cleanNumber}`;
              await database.collection('sessions').updateOne(
                { sessionId: sessionName },
                {
                  $set: {
                    sessionId: sessionName,
                    creds: credsData,
                    phone: cleanNumber,
                    active: true,
                    updatedAt: new Date()
                  },
                  $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
              );
              console.log(`[DB] Saved session for ${cleanNumber}`);
            }
          } catch (dbErr) {
            console.error('[DB] Save error:', dbErr.message);
          }

          pairingRequests[requestId] = {
            status: 'connected',
            sessionId,
            phone: cleanNumber
          };

          // Disconnect after saving
          setTimeout(() => {
            try { sock.end(); } catch (_) {}
            delete activeSockets[requestId];
          }, 3000);

          // Clean up temp files
          setTimeout(() => {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
          }, 8000);

        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[PAIR] ${requestId} closed (code: ${statusCode})`);
          
          if (pairingRequests[requestId]?.status !== 'connected') {
            if (statusCode === 401 || statusCode === 403) {
              pairingRequests[requestId] = { status: 'error', error: 'Pairing rejected or expired. Try again.' };
            } else if (statusCode === 515 || statusCode === 503) {
              pairingRequests[requestId] = { status: 'error', error: 'WhatsApp server unavailable. Try again in a moment.' };
            } else {
              pairingRequests[requestId] = { status: 'error', error: `Connection closed (code: ${statusCode}). Try again.` };
            }
          }
          delete activeSockets[requestId];
        }
      } catch (err) {
        console.error(`[PAIR] connection.update error:`, err);
        pairingRequests[requestId] = { status: 'error', error: err.message };
      }
    });

    // Wait for socket to initialize before requesting pairing code
    await new Promise(resolve => setTimeout(resolve, 2500));

    if (!sock.authState.creds.registered) {
      try {
        const pairingCode = await sock.requestPairingCode(cleanNumber);
        pairingRequests[requestId] = { 
          status: 'pairing', 
          pairingCode, 
          phone: cleanNumber 
        };
        console.log(`[PAIR] Code for ${cleanNumber}: ${pairingCode}`);

        res.json({ success: true, requestId, pairingCode });
      } catch (pairErr) {
        console.error(`[PAIR] requestPairingCode error:`, pairErr);
        pairingRequests[requestId] = { status: 'error', error: 'Failed to generate pairing code.' };
        try { sock.end(); } catch (_) {}
        delete activeSockets[requestId];
        res.json({ success: false, error: 'Failed to generate pairing code. Check your number and try again.' });
      }
    } else {
      pairingRequests[requestId] = { status: 'error', error: 'Already registered.' };
      res.json({ success: false, error: 'Already registered.' });
    }

    // Auto-cleanup after 3 minutes
    setTimeout(() => {
      if (pairingRequests[requestId]?.status === 'pairing') {
        pairingRequests[requestId] = { status: 'error', error: 'Timed out (3 minutes).' };
        try { if (activeSockets[requestId]) activeSockets[requestId].end(); } catch (_) {}
        delete activeSockets[requestId];
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
      setTimeout(() => { delete pairingRequests[requestId]; }, 7 * 60 * 1000);
    }, 3 * 60 * 1000);

  } catch (err) {
    console.error('[PAIR] Error:', err);
    return res.json({ success: false, error: err.message });
  }
});

/**
 * GET /api/status?id=<requestId>
 */
app.get('/api/status', (req, res) => {
  const { id } = req.query;
  if (!id || !pairingRequests[id]) {
    return res.json({ status: 'error', error: 'Invalid or expired request. Please try again.' });
  }
  return res.json(pairingRequests[id]);
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    name: 'LOYALTY MD Session Generator', 
    activePairings: Object.keys(pairingRequests).length,
    activeSockets: Object.keys(activeSockets).length
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server (persistent — works on Render, Railway, VPS)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n====================================`);
  console.log(`  👑 LOYALTY MD Session Generator`);
  console.log(`  🌐 Running on port ${PORT}`);
  console.log(`====================================\n`);
});

module.exports = app;
