/*
  LOYALTY MD Session Generator API
  Runs on Vercel as a serverless function
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

// In-memory store for active pairing requests
const pairingRequests = {};

// MongoDB connection
let db = null;
async function getDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db('loyaltymd');
  return db;
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
    const requestId = `session_${cleanNumber}_${Date.now()}`;
    const tempDir = path.join(os.tmpdir(), 'loyalty-sessions', requestId);
    fs.mkdirSync(tempDir, { recursive: true });

    pairingRequests[requestId] = { status: 'pairing', phone: cleanNumber };

    // Start Baileys in the background
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }).child({ level: 'silent' }))
      },
      browser: ["Ubuntu", "Chrome", "20.0.00"]
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code
    const pairingCode = await sock.requestPairingCode(cleanNumber);
    pairingRequests[requestId].pairingCode = pairingCode;

    // Listen for connection
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        try {
          // Connected! Read creds and encode as session ID
          const credsPath = path.join(tempDir, 'creds.json');
          const credsData = fs.readFileSync(credsPath, 'utf8');
          const sessionId = Buffer.from(credsData).toString('base64');

          // Save to MongoDB
          try {
            const database = await getDB();
            const sessionName = `session_${cleanNumber}`;
            await database.collection('sessions').updateOne(
              { sessionId: sessionName },
              {
                $set: {
                  sessionId: sessionName,
                  creds: credsData,
                  authState: credsData,
                  phone: cleanNumber,
                  active: true,
                  updatedAt: new Date()
                },
                $setOnInsert: { createdAt: new Date() }
              },
              { upsert: true }
            );
          } catch (dbErr) {
            console.error('DB save error:', dbErr.message);
          }

          pairingRequests[requestId] = {
            status: 'connected',
            sessionId: `LOYALTY-MD~${sessionId}`,
            phone: cleanNumber
          };

          // Disconnect after saving
          setTimeout(() => {
            try { sock.end(); } catch (_) {}
          }, 2000);

          // Clean up temp files after a delay
          setTimeout(() => {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
          }, 5000);

        } catch (err) {
          console.error('Post-connect error:', err);
          pairingRequests[requestId] = { status: 'error', error: err.message };
        }
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 401 || statusCode === 403) {
          pairingRequests[requestId] = { status: 'error', error: 'Pairing rejected or expired.' };
        }
      }
    });

    // Auto-cleanup after 2 minutes
    setTimeout(() => {
      if (pairingRequests[requestId]?.status === 'pairing') {
        pairingRequests[requestId] = { status: 'error', error: 'Timed out waiting for pairing.' };
        try { sock.end(); } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
      // Clean up request after 5 minutes total
      setTimeout(() => { delete pairingRequests[requestId]; }, 180000);
    }, 120000);

    return res.json({
      success: true,
      requestId,
      pairingCode
    });

  } catch (err) {
    console.error('Pair error:', err);
    return res.json({ success: false, error: err.message });
  }
});

/**
 * GET /api/status?id=<requestId>
 * Returns: { status: 'pairing'|'connected'|'error', sessionId?, error? }
 */
app.get('/api/status', (req, res) => {
  const { id } = req.query;
  if (!id || !pairingRequests[id]) {
    return res.json({ status: 'error', error: 'Invalid or expired request.' });
  }
  return res.json(pairingRequests[id]);
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'LOYALTY MD Session Generator', sessions: Object.keys(pairingRequests).length });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// For Vercel serverless
module.exports = app;

// For local dev
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`LOYALTY MD Session Generator running on http://localhost:${PORT}`);
  });
}
