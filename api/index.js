/*
  LOYALTY MD Session Generator API
  Works on Vercel (with SSE), Railway, Render, and any VPS.
  
  Uses Server-Sent Events so the connection stays alive
  during the entire pairing process.
  
  IMPORTANT: Session ID is ONLY returned after connection: 'open'
  to ensure the WhatsApp handshake fully completes.
*/

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
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
const TIMEOUT_MS = IS_VERCEL ? 55000 : 120000; // 55s on Vercel, 120s on Railway/VPS

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

/**
 * Helper: read creds, encode session ID, save to DB, send to client
 */
async function finalizeSession(cleanNumber, tempDir, sendEvent, res, sockRef) {
  const credsPath = path.join(tempDir, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    sendEvent({ type: 'error', error: 'Credentials file not created.' });
    try { res.end(); } catch (_) {}
    return;
  }

  const credsData = fs.readFileSync(credsPath, 'utf8');
  const sessionId = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;

  // Save to MongoDB if available
  try {
    const database = await getDB();
    if (database) {
      await database.collection('sessions').updateOne(
        { sessionId: `session_${cleanNumber}` },
        {
          $set: {
            sessionId: `session_${cleanNumber}`,
            creds: credsData,
            phone: cleanNumber,
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

  // Give WhatsApp a moment to fully sync, then clean up
  setTimeout(() => {
    try { if (sockRef.sock) sockRef.sock.end(); } catch (_) {}
    try { res.end(); } catch (_) {}
  }, 3000);
  setTimeout(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }, 6000);
}

/**
 * GET /api/pair?phone=1234567890
 * 
 * Uses Server-Sent Events (SSE) to keep the connection alive.
 */
app.get('/api/pair', async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/[^0-9]/g, '').length < 7) {
    if (req.headers.accept !== 'text/event-stream') {
      return res.json({ success: false, error: 'Invalid phone number.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Invalid phone number.' })}\n\n`);
    res.end();
    return;
  }

  const cleanNumber = phone.replace(/[^0-9]/g, '');

  // Set up SSE headers
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

  // Use an object ref so reconnects can update the socket
  const sockRef = { sock: null };
  let finished = false;
  let retryCount = 0;
  const MAX_RETRIES = 3;

  const tempDir = path.join(os.tmpdir(), `loyalty-pair-${cleanNumber}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  /**
   * Create a Baileys socket.
   * If reuse=true, reuses existing creds in tempDir (for 428 reconnect).
   * If reuse=false, wipes tempDir first (for 515/503 retry).
   */
  async function createSocket(reuse = false) {
    if (!reuse) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
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

    // Just save creds — do NOT grab session ID here
    newSock.ev.on('creds.update', saveCreds);

    newSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      try {
        if (connection === 'open' && !finished) {
          // ✅ THIS is the only place we return the session ID
          // The handshake is fully complete at this point
          finished = true;
          console.log(`[PAIR] ${cleanNumber} fully connected!`);
          await finalizeSession(cleanNumber, tempDir, sendEvent, res, sockRef);
        }
        else if (connection === 'close' && !finished) {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[PAIR] ${cleanNumber} closed (code: ${statusCode})`);

          if (statusCode === DisconnectReason.restartRequired || statusCode === 428) {
            // 428 = restart required after pairing — reconnect with SAME creds
            console.log(`[PAIR] ${cleanNumber} 428 restart — reconnecting with existing creds...`);
            sendEvent({ type: 'status', message: 'Finalizing connection...' });
            
            try { sockRef.sock?.end(); } catch (_) {}
            await new Promise(r => setTimeout(r, 2000));

            if (!finished) {
              sockRef.sock = await createSocket(true); // reuse = true
            }
          }
          else if (statusCode === 401 || statusCode === 403) {
            sendEvent({ type: 'error', error: 'Pairing rejected or expired. Reload and try again.' });
            finished = true;
            try { res.end(); } catch (_) {}
          }
          else if ((statusCode === 515 || statusCode === 503) && retryCount < MAX_RETRIES) {
            retryCount++;
            console.log(`[PAIR] Server busy, retrying (${retryCount}/${MAX_RETRIES})...`);
            sendEvent({ type: 'status', message: `WhatsApp server busy. Retrying (${retryCount}/${MAX_RETRIES})...` });
            
            try { sockRef.sock?.end(); } catch (_) {}
            await new Promise(r => setTimeout(r, 3000));

            if (!finished) {
              sockRef.sock = await createSocket(false); // fresh socket

              // Re-request pairing code
              setTimeout(async () => {
                try {
                  if (!finished && sockRef.sock && !sockRef.sock.authState.creds.registered) {
                    const code = await sockRef.sock.requestPairingCode(cleanNumber);
                    console.log(`[PAIR] Retry code for ${cleanNumber}: ${code}`);
                    sendEvent({ type: 'code', code });
                  }
                } catch (e) {
                  console.error('[PAIR] Retry pairing code error:', e.message);
                  if (!finished) {
                    sendEvent({ type: 'error', error: 'Failed to get pairing code on retry.' });
                    finished = true;
                    try { res.end(); } catch (_) {}
                  }
                }
              }, 3000);
            }
          }
          else if (statusCode === 515 || statusCode === 503) {
            sendEvent({ type: 'error', error: 'WhatsApp server busy. Please wait a minute and try again.' });
            finished = true;
            try { res.end(); } catch (_) {}
          }
          else {
            sendEvent({ type: 'error', error: `Connection lost (code ${statusCode || 'unknown'}). Reload and try again.` });
            finished = true;
            try { res.end(); } catch (_) {}
          }
        }
      } catch (err) {
        console.error('[PAIR] connection.update error:', err);
        if (!finished) {
          sendEvent({ type: 'error', error: err.message || 'Unknown error' });
          finished = true;
          try { res.end(); } catch (_) {}
        }
      }
    });

    return newSock;
  }

  try {
    sockRef.sock = await createSocket(false);

    // Wait for socket to initialize
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (finished) return;

    if (!sockRef.sock.authState.creds.registered) {
      const pairingCode = await sockRef.sock.requestPairingCode(cleanNumber);
      console.log(`[PAIR] Code for ${cleanNumber}: ${pairingCode}`);
      sendEvent({ type: 'code', code: pairingCode });
    } else {
      sendEvent({ type: 'error', error: 'Number already registered.' });
      finished = true;
      res.end();
      return;
    }

    // Timeout
    setTimeout(() => {
      if (!finished) {
        sendEvent({ type: 'error', error: `Timed out (${TIMEOUT_MS / 1000}s). Reload and try again.` });
        finished = true;
        try { sockRef.sock?.end(); } catch (_) {}
        try { res.end(); } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    }, TIMEOUT_MS);

  } catch (err) {
    console.error('[PAIR] Error:', err);
    sendEvent({ type: 'error', error: err.message || 'Failed to connect.' });
    finished = true;
    try { sockRef.sock?.end(); } catch (_) {}
    try { res.end(); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }

  // Client disconnect cleanup
  req.on('close', () => {
    if (!finished) {
      finished = true;
      try { sockRef.sock?.end(); } catch (_) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
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
