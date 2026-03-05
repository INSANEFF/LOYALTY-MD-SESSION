/*
  LOYALTY MD Session Generator API
  Works on Vercel (SSE), Railway, Render, and any VPS.

  Strategy (inspired by GlobalTechInfo/PAIRING-WEB):
  1. Request pairing code ONCE
  2. After user enters code, WhatsApp fires connection close (428)
  3. Auto-reconnect with SAME creds — this reaches connection: 'open'
  4. ONLY on 'open' do we grab creds and return the session ID
  5. Clean up listeners before every reconnect
*/

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  delay,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');

const IS_VERCEL = !!process.env.VERCEL;
const TIMEOUT_MS = IS_VERCEL ? 55000 : 5 * 60 * 1000; // 55s Vercel, 5 min Railway/VPS
const MAX_RECONNECTS = 3;
const CLEANUP_DELAY = 5000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// MongoDB connection (optional)
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

async function removeDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

/**
 * GET /api/pair?phone=1234567890
 * Uses Server-Sent Events (SSE) to keep the connection alive.
 */
app.get('/api/pair', async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/[^0-9]/g, '').length < 7) {
    if (req.headers.accept !== 'text/event-stream') {
      return res.json({ success: false, error: 'Invalid phone number.' });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Invalid phone number.' })}\n\n`);
    res.end();
    return;
  }

  const num = phone.replace(/[^0-9]/g, '');

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  function sendEvent(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  sendEvent({ type: 'status', message: 'Connecting to WhatsApp...' });

  const tempDir = path.join(os.tmpdir(), `loyalty-pair-${num}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  let currentSocket = null;
  let sessionCompleted = false;
  let isCleaningUp = false;
  let pairingCodeSent = false;
  let reconnectAttempts = 0;
  let timeoutHandle = null;

  // Cleanup everything
  async function cleanup(reason = 'unknown') {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log(`[PAIR] Cleanup ${num} — ${reason}`);

    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }

    if (currentSocket) {
      try {
        currentSocket.ev.removeAllListeners();
        currentSocket.end();
      } catch (_) {}
      currentSocket = null;
    }

    setTimeout(() => removeDir(tempDir), CLEANUP_DELAY);
  }

  // Main session function — called recursively on reconnect
  async function initiateSession() {
    if (sessionCompleted || isCleaningUp) return;

    if (reconnectAttempts >= MAX_RECONNECTS) {
      console.log(`[PAIR] Max reconnects reached for ${num}`);
      sendEvent({ type: 'error', error: 'Connection failed after multiple attempts. Reload and try again.' });
      await cleanup('max_reconnects');
      try { res.end(); } catch (_) {}
      return;
    }

    try {
      // Create auth dir if needed (don't wipe — reuse creds from previous attempt)
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(tempDir);
      const { version } = await fetchLatestBaileysVersion();

      // Clean up previous socket listeners
      if (currentSocket) {
        try { currentSocket.ev.removeAllListeners(); currentSocket.end(); } catch (_) {}
      }

      currentSocket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.00"],
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 3
      });

      const sock = currentSocket;

      // Connection handler
      sock.ev.on('connection.update', async (update) => {
        if (isCleaningUp) return;
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          if (sessionCompleted) return;
          sessionCompleted = true;

          console.log(`[PAIR] ${num} connection OPEN — session complete!`);

          try {
            const credsPath = path.join(tempDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsData = fs.readFileSync(credsPath, 'utf8');
              const sessionId = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;

              // Save to MongoDB
              try {
                const database = await getDB();
                if (database) {
                  await database.collection('sessions').updateOne(
                    { sessionId: `session_${num}` },
                    {
                      $set: {
                        sessionId: `session_${num}`,
                        creds: credsData,
                        phone: num,
                        active: true,
                        updatedAt: new Date()
                      },
                      $setOnInsert: { createdAt: new Date() }
                    },
                    { upsert: true }
                  );
                }
              } catch (dbErr) {
                console.error('[DB] Save error:', dbErr.message);
              }

              sendEvent({ type: 'connected', sessionId });
            } else {
              sendEvent({ type: 'error', error: 'Credentials file not found.' });
            }
          } catch (err) {
            console.error('[PAIR] Error reading creds:', err);
            sendEvent({ type: 'error', error: 'Failed to read session.' });
          } finally {
            await delay(1000);
            await cleanup('session_complete');
            try { res.end(); } catch (_) {}
          }
        }

        if (connection === 'close') {
          if (sessionCompleted || isCleaningUp) {
            await cleanup('already_complete');
            return;
          }

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[PAIR] ${num} closed — code: ${statusCode}`);

          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            // Logged out or invalid pairing
            console.log(`[PAIR] ${num} logged out / invalid pairing`);
            sendEvent({ type: 'error', error: 'Pairing rejected or expired. Reload and try again.' });
            await cleanup('logged_out');
            try { res.end(); } catch (_) {}
          } else if (pairingCodeSent && !sessionCompleted) {
            // Pairing code was sent, connection closed (likely 428 restart)
            // Auto-reconnect with same creds
            reconnectAttempts++;
            console.log(`[PAIR] ${num} reconnecting (${reconnectAttempts}/${MAX_RECONNECTS})...`);
            sendEvent({ type: 'status', message: 'Finalizing connection...' });
            await delay(2000);
            await initiateSession();
          } else {
            // Connection died before we even got the pairing code out
            sendEvent({ type: 'error', error: `Connection lost (code ${statusCode || 'unknown'}). Reload and try again.` });
            await cleanup('connection_closed');
            try { res.end(); } catch (_) {}
          }
        }
      });

      // Request pairing code (only once)
      if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
        await delay(1500);
        try {
          pairingCodeSent = true;
          let code = await sock.requestPairingCode(num);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log(`[PAIR] Code for ${num}: ${code}`);
          sendEvent({ type: 'code', code });
        } catch (err) {
          console.error('[PAIR] Pairing code error:', err.message);
          pairingCodeSent = false;
          sendEvent({ type: 'error', error: 'Failed to get pairing code. Reload and try again.' });
          await cleanup('pairing_code_error');
          try { res.end(); } catch (_) {}
        }
      }

      // Save creds on update
      sock.ev.on('creds.update', saveCreds);

      // Session timeout
      if (!timeoutHandle) {
        timeoutHandle = setTimeout(async () => {
          if (!sessionCompleted && !isCleaningUp) {
            console.log(`[PAIR] Timeout for ${num}`);
            sendEvent({ type: 'error', error: 'Pairing timed out. Reload and try again.' });
            await cleanup('timeout');
            try { res.end(); } catch (_) {}
          }
        }, TIMEOUT_MS);
      }

    } catch (err) {
      console.error(`[PAIR] Init error for ${num}:`, err);
      sendEvent({ type: 'error', error: 'Failed to connect. Reload and try again.' });
      await cleanup('init_error');
      try { res.end(); } catch (_) {}
    }
  }

  // Client disconnect cleanup
  req.on('close', () => {
    if (!sessionCompleted && !isCleaningUp) {
      cleanup('client_disconnect');
    }
  });

  await initiateSession();
});

// Legacy POST endpoint
app.post('/api/pair', async (req, res) => {
  const phone = req.body?.phone;
  if (!phone) return res.json({ success: false, error: 'Missing phone number.' });
  return res.json({
    success: false,
    error: 'Use the web interface instead.',
    redirect: `/api/pair?phone=${phone.replace(/[^0-9]/g, '')}`
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'LOYALTY MD Session Generator' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Suppress EventEmitter warnings
require('events').EventEmitter.defaultMaxListeners = 500;

// Ignore common Baileys errors
process.on('uncaughtException', (err) => {
  const e = String(err);
  const ignore = [
    'conflict', 'not-authorized', 'Socket connection timeout',
    'rate-overlimit', 'Connection Closed', 'Timed Out',
    'Value not found', 'Stream Errored', 'restart required',
    'statusCode: 515', 'statusCode: 503'
  ];
  if (!ignore.some(x => e.includes(x))) {
    console.error('[UNCAUGHT]', err);
  }
});

// Start server (Railway, Render, VPS, local dev)
const PORT = process.env.PORT || 3000;
if (!IS_VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n====================================`);
    console.log(`  👑 LOYALTY MD Session Generator`);
    console.log(`  🌐 Running on 0.0.0.0:${PORT}`);
    console.log(`  ⏱  Timeout: ${TIMEOUT_MS / 1000}s`);
    console.log(`====================================\n`);
  });
}

module.exports = app;
