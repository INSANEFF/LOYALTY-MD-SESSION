import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  DisconnectReason
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import events from 'events';

events.EventEmitter.defaultMaxListeners = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_VERCEL = !!process.env.VERCEL;
const TIMEOUT_MS = IS_VERCEL ? 55000 : 5 * 60 * 1000;
const MAX_RECONNECTS = 5;
const CLEANUP_DELAY = 5000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// MongoDB (optional)
let db = null;
async function getDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  try {
    const client = new MongoClient(uri, { connectTimeoutMS: 10000, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db('loyaltymd');
    return db;
  } catch (_) { return null; }
}

async function removeFile(p) {
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ============================================================
//  PAIRING CODE endpoint — SSE
// ============================================================
app.get('/api/pair', async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/[^0-9]/g, '').length < 7) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Invalid phone number.' })}\n\n`);
    res.end();
    return;
  }

  const num = phone.replace(/[^0-9]/g, '');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch (_) {} };
  send({ type: 'status', message: 'Connecting to WhatsApp...' });

  const sid = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  const dirs = path.join(os.tmpdir(), `loyalty-pair-${sid}`);
  fs.mkdirSync(dirs, { recursive: true });

  let currentSocket = null, sessionCompleted = false, isCleaningUp = false;
  let pairingCodeSent = false, reconnectAttempts = 0, timeoutHandle = null;

  // Heartbeat to keep SSE alive
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 10000);

  async function cleanup(reason) {
    if (isCleaningUp) return;
    isCleaningUp = true;
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (heartbeat) clearInterval(heartbeat);
    if (currentSocket) { try { currentSocket.ev.removeAllListeners(); currentSocket.end(); } catch (_) {} currentSocket = null; }
    setTimeout(() => removeFile(dirs), CLEANUP_DELAY);
  }

  async function initiateSession() {
    if (sessionCompleted || isCleaningUp) return;
    if (reconnectAttempts >= MAX_RECONNECTS) {
      send({ type: 'error', error: 'Connection failed after multiple attempts. Reload and try again.' });
      await cleanup('max_reconnects'); try { res.end(); } catch (_) {} return;
    }

    try {
      if (!fs.existsSync(dirs)) fs.mkdirSync(dirs, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(dirs);
      const { version } = await fetchLatestBaileysVersion();

      if (currentSocket) { try { currentSocket.ev.removeAllListeners(); currentSocket.end(); } catch (_) {} }

      currentSocket = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })) },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 3
      });

      const sock = currentSocket;

      sock.ev.on('connection.update', async (update) => {
        if (isCleaningUp) return;
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          if (sessionCompleted) return;
          sessionCompleted = true;
          try {
            const credsPath = path.join(dirs, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsData = fs.readFileSync(credsPath, 'utf8');
              const sessionId = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;
              try {
                const database = await getDB();
                if (database) {
                  await database.collection('sessions').updateOne(
                    { sessionId: `session_${num}` },
                    { $set: { sessionId: `session_${num}`, creds: credsData, phone: num, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                    { upsert: true }
                  );
                }
              } catch (_) {}
              send({ type: 'connected', sessionId });
            } else {
              send({ type: 'error', error: 'Credentials file not found.' });
            }
          } catch (err) {
            send({ type: 'error', error: 'Failed to read session.' });
          } finally {
            await delay(1000);
            await cleanup('session_complete');
            try { res.end(); } catch (_) {}
          }
        }

        if (connection === 'close') {
          if (sessionCompleted || isCleaningUp) { await cleanup('done'); return; }
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut || code === 401) {
            send({ type: 'error', error: 'Pairing rejected or expired. Reload and try again.' });
            await cleanup('logged_out'); try { res.end(); } catch (_) {}
          } else if (!sessionCompleted) {
            reconnectAttempts++;
            send({ type: 'status', message: pairingCodeSent ? 'Finalizing connection...' : 'Reconnecting...' });
            await delay(1000);
            await initiateSession();
          }
        }
      });

      if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
        await delay(500);
        try {
          pairingCodeSent = true;
          let code = await sock.requestPairingCode(num);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          send({ type: 'code', code });
        } catch (err) {
          pairingCodeSent = false;
          send({ type: 'error', error: 'Failed to get pairing code. Reload and try again.' });
          await cleanup('pairing_code_error'); try { res.end(); } catch (_) {}
        }
      }

      sock.ev.on('creds.update', saveCreds);

      if (!timeoutHandle) {
        timeoutHandle = setTimeout(async () => {
          if (!sessionCompleted && !isCleaningUp) {
            send({ type: 'error', error: 'Pairing timed out. Reload and try again.' });
            await cleanup('timeout'); try { res.end(); } catch (_) {}
          }
        }, TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[PAIR] Init error:', err);
      send({ type: 'error', error: 'Failed to connect. Reload and try again.' });
      await cleanup('init_error'); try { res.end(); } catch (_) {}
    }
  }

  req.on('close', () => { if (!sessionCompleted && !isCleaningUp) cleanup('client_disconnect'); });
  await initiateSession();
});

// ============================================================
//  QR CODE endpoint — SSE
// ============================================================
app.get('/api/qr', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch (_) {} };
  send({ type: 'status', message: 'Generating QR code...' });

  const sid = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  const dirs = path.join(os.tmpdir(), `loyalty-qr-${sid}`);
  fs.mkdirSync(dirs, { recursive: true });

  let currentSocket = null, sessionCompleted = false, isCleaningUp = false;
  let qrSent = false, reconnectAttempts = 0, timeoutHandle = null;

  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 10000);

  async function cleanup(reason) {
    if (isCleaningUp) return;
    isCleaningUp = true;
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (heartbeat) clearInterval(heartbeat);
    if (currentSocket) { try { currentSocket.ev.removeAllListeners(); currentSocket.end(); } catch (_) {} currentSocket = null; }
    setTimeout(() => removeFile(dirs), CLEANUP_DELAY);
  }

  async function initiateSession() {
    if (sessionCompleted || isCleaningUp) return;
    if (reconnectAttempts >= MAX_RECONNECTS) {
      send({ type: 'error', error: 'Connection failed. Reload and try again.' });
      await cleanup('max_reconnects'); try { res.end(); } catch (_) {} return;
    }

    try {
      if (!fs.existsSync(dirs)) fs.mkdirSync(dirs, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(dirs);
      const { version } = await fetchLatestBaileysVersion();

      if (currentSocket) { try { currentSocket.ev.removeAllListeners(); currentSocket.end(); } catch (_) {} }

      currentSocket = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })) },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 3
      });

      const sock = currentSocket;

      sock.ev.on('connection.update', async (update) => {
        if (isCleaningUp) return;
        const { connection, lastDisconnect, qr } = update;

        // QR code received — send as base64 image
        if (qr && !sessionCompleted) {
          try {
            const qrDataURL = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', width: 300 });
            send({ type: 'qr', qr: qrDataURL });
            qrSent = true;
          } catch (_) {}
        }

        if (connection === 'open') {
          if (sessionCompleted) return;
          sessionCompleted = true;
          try {
            const credsPath = path.join(dirs, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsData = fs.readFileSync(credsPath, 'utf8');
              const sessionId = `LOYALTY-MD~${Buffer.from(credsData).toString('base64')}`;
              try {
                const database = await getDB();
                if (database) {
                  await database.collection('sessions').updateOne(
                    { sessionId: `session_qr_${sid}` },
                    { $set: { sessionId: `session_qr_${sid}`, creds: credsData, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                    { upsert: true }
                  );
                }
              } catch (_) {}
              send({ type: 'connected', sessionId });
            } else {
              send({ type: 'error', error: 'Credentials file not found.' });
            }
          } catch (err) {
            send({ type: 'error', error: 'Failed to read session.' });
          } finally {
            await delay(1000);
            await cleanup('session_complete');
            try { res.end(); } catch (_) {}
          }
        }

        if (connection === 'close') {
          if (sessionCompleted || isCleaningUp) { await cleanup('done'); return; }
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut || code === 401) {
            send({ type: 'error', error: 'Session rejected. Reload and try again.' });
            await cleanup('logged_out'); try { res.end(); } catch (_) {}
          } else if (!sessionCompleted) {
            reconnectAttempts++;
            send({ type: 'status', message: 'Reconnecting...' });
            await delay(1000);
            await initiateSession();
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      if (!timeoutHandle) {
        timeoutHandle = setTimeout(async () => {
          if (!sessionCompleted && !isCleaningUp) {
            send({ type: 'error', error: 'QR pairing timed out. Reload and try again.' });
            await cleanup('timeout'); try { res.end(); } catch (_) {}
          }
        }, TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[QR] Init error:', err);
      send({ type: 'error', error: 'Failed to connect. Reload and try again.' });
      await cleanup('init_error'); try { res.end(); } catch (_) {}
    }
  }

  req.on('close', () => { if (!sessionCompleted && !isCleaningUp) cleanup('client_disconnect'); });
  await initiateSession();
});

// Legacy POST
app.post('/api/pair', (req, res) => {
  const phone = req.body?.phone;
  if (!phone) return res.json({ success: false, error: 'Missing phone number.' });
  res.json({ success: false, error: 'Use the web interface.', redirect: `/api/pair?phone=${phone.replace(/[^0-9]/g, '')}` });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'LOYALTY MD Session Generator' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Ignore common Baileys crashes
process.on('uncaughtException', (err) => {
  const e = String(err);
  const ignore = ['conflict', 'not-authorized', 'Socket connection timeout', 'rate-overlimit',
    'Connection Closed', 'Timed Out', 'Value not found', 'Stream Errored', 'restart required',
    'statusCode: 515', 'statusCode: 503'];
  if (!ignore.some(x => e.includes(x))) console.error('[UNCAUGHT]', err);
});

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

export default app;
