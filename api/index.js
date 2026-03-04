/*
  LOYALTY MD Session Generator API
  Works on Vercel (with SSE) and persistent servers (Render, Railway, VPS).
  
  Key: Uses Server-Sent Events so the connection stays alive
  during the entire pairing process (up to 55 seconds).
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
 * GET /api/pair?phone=1234567890
 * 
 * Uses Server-Sent Events (SSE) to keep the connection alive.
 * Flow:
 *   1. Client opens SSE connection
 *   2. Server creates Baileys socket, gets pairing code
 *   3. Server sends pairing code event → client displays it
 *   4. Server waits for user to enter code on phone (up to 55s)
 *   5. Server sends session ID event → client shows it
 *   6. Connection closes
 */
app.get('/api/pair', async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/[^0-9]/g, '').length < 7) {
    // If not SSE request, return JSON error
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
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });

  // Helper to send SSE events
  function sendEvent(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  sendEvent({ type: 'status', message: 'Connecting to WhatsApp...' });

  let sock = null;
  let finished = false;

  const tempDir = path.join(os.tmpdir(), `loyalty-pair-${cleanNumber}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Track retries for server-busy errors
  let retryCount = 0;
  const MAX_RETRIES = 2;

  // Helper to create a new socket and wire up events
  async function createSocket() {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(tempDir, { recursive: true });

    const { state: authState, saveCreds: saveFn } = await useMultiFileAuthState(tempDir);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
      version,
      printQRInTerminal: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 55000,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' }).child({ level: 'silent' }))
      },
      browser: ["Ubuntu", "Chrome", "20.0.00"]
    });

    newSock.ev.on('creds.update', async () => {
      await saveFn();
      // Check if pairing just completed (registered became true)
      try {
        const credsPath = path.join(tempDir, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const savedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          if (savedCreds.registered && !finished) {
            finished = true;
            console.log(`[PAIR] ${cleanNumber} paired via creds.update!`);
            const credsData = fs.readFileSync(credsPath, 'utf8');
            const sid = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;
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
            sendEvent({ type: 'connected', sessionId: sid });
            setTimeout(() => {
              try { newSock.end(); } catch (_) {}
              try { res.end(); } catch (_) {}
            }, 2000);
            setTimeout(() => {
              try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
            }, 5000);
          }
        }
      } catch (_) {}
    });
    newSock.ev.on('connection.update', handleConnection);

    return newSock;
  }

  // Named connection handler (allows re-binding on retry)
  async function handleConnection({ connection, lastDisconnect }) {
    try {
      if (connection === 'open' && !finished) {
        finished = true;
        console.log(`[PAIR] ${cleanNumber} connected!`);

        // Read creds and encode
        const credsPath = path.join(tempDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
          sendEvent({ type: 'error', error: 'Credentials file not created.' });
          res.end();
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
        
        // Cleanup
        setTimeout(() => {
          try { sock.end(); } catch (_) {}
          try { res.end(); } catch (_) {}
        }, 2000);
        setTimeout(() => {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }, 5000);

      } else if (connection === 'close' && !finished) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[PAIR] ${cleanNumber} closed (code: ${statusCode})`);

        // Status 428 = restart required — pairing may have succeeded
        // Check if creds were saved with registered=true
        if (statusCode === 428) {
          console.log(`[PAIR] ${cleanNumber} got 428 (restart required), checking creds...`);
          await new Promise(r => setTimeout(r, 1500));
          try {
            const credsPath = path.join(tempDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const savedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
              if (savedCreds.registered && !finished) {
                finished = true;
                const credsData = fs.readFileSync(credsPath, 'utf8');
                const sid = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;
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
                sendEvent({ type: 'connected', sessionId: sid });
                setTimeout(() => { try { res.end(); } catch (_) {} }, 2000);
                setTimeout(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} }, 5000);
                return;
              }
            }
          } catch (_) {}
          // If creds not registered, treat as error
          sendEvent({ type: 'error', error: 'Connection restarted. Reload and try again.' });
          finished = true;
          try { res.end(); } catch (_) {}
        } else if (statusCode === 401 || statusCode === 403) {
          sendEvent({ type: 'error', error: 'Pairing rejected or expired. Reload and try again.' });
          finished = true;
          try { res.end(); } catch (_) {}
        } else if ((statusCode === 515 || statusCode === 503) && retryCount < MAX_RETRIES) {
          // WhatsApp server busy — auto-retry
          retryCount++;
          console.log(`[PAIR] Server busy, retrying (${retryCount}/${MAX_RETRIES})...`);
          sendEvent({ type: 'status', message: `WhatsApp server busy. Retrying (${retryCount}/${MAX_RETRIES})...` });
          
          try { sock.end(); } catch (_) {}
          await new Promise(r => setTimeout(r, 3000));
          
          // Create a fresh socket
          sock = await createSocket();

          // Request pairing code after reconnect
          setTimeout(async () => {
            try {
              if (!finished && !sock.authState.creds.registered) {
                const code = await sock.requestPairingCode(cleanNumber);
                console.log(`[PAIR] Retry code for ${cleanNumber}: ${code}`);
                sendEvent({ type: 'code', code });
              }
            } catch (e) {
              console.error('[PAIR] Retry pairing code error:', e.message);
              sendEvent({ type: 'error', error: 'Failed to get pairing code on retry.' });
              finished = true;
              try { res.end(); } catch (_) {}
            }
          }, 3000);
        } else if (statusCode === 515 || statusCode === 503) {
          sendEvent({ type: 'error', error: 'WhatsApp server busy. Please wait a minute and try again.' });
          finished = true;
          try { res.end(); } catch (_) {}
        } else {
          sendEvent({ type: 'error', error: `Connection lost (${statusCode}). Reload and try again.` });
          finished = true;
          try { res.end(); } catch (_) {}
        }
      }
    } catch (err) {
      console.error('[PAIR] connection.update error:', err);
      if (!finished) {
        sendEvent({ type: 'error', error: err.message });
        finished = true;
        try { res.end(); } catch (_) {}
      }
    }
  }

  try {
    // Create initial socket
    sock = await createSocket();

    // Wait for socket init, then request pairing code
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (finished) return; // Already errored out

    if (!sock.authState.creds.registered) {
      const pairingCode = await sock.requestPairingCode(cleanNumber);
      console.log(`[PAIR] Code for ${cleanNumber}: ${pairingCode}`);
      sendEvent({ type: 'code', code: pairingCode });
    } else {
      sendEvent({ type: 'error', error: 'Number already registered.' });
      finished = true;
      res.end();
      return;
    }

    // Timeout after 55 seconds (Vercel limit is 60s)
    setTimeout(() => {
      if (!finished) {
        sendEvent({ type: 'error', error: 'Timed out (55s). Reload and try again.' });
        finished = true;
        try { sock.end(); } catch (_) {}
        try { res.end(); } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    }, 55000);

  } catch (err) {
    console.error('[PAIR] Error:', err);
    sendEvent({ type: 'error', error: err.message || 'Failed to connect.' });
    finished = true;
    try { if (sock) sock.end(); } catch (_) {}
    try { res.end(); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }

  // If client disconnects early, clean up
  req.on('close', () => {
    if (!finished) {
      finished = true;
      try { if (sock) sock.end(); } catch (_) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

// Legacy POST endpoint (for Render/persistent servers)
app.post('/api/pair', async (req, res) => {
  // Redirect to SSE approach
  const phone = req.body?.phone;
  if (!phone) return res.json({ success: false, error: 'Missing phone number.' });
  return res.json({ 
    success: false, 
    error: 'Use the web interface instead.',
    redirect: `/api/pair?phone=${phone.replace(/[^0-9]/g, '')}` 
  });
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'LOYALTY MD Session Generator' });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server (for Render, Railway, VPS, local dev)
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n====================================`);
    console.log(`  👑 LOYALTY MD Session Generator`);
    console.log(`  🌐 Running on port ${PORT}`);
    console.log(`====================================\n`);
  });
}

module.exports = app;
