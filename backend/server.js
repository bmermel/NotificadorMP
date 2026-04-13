'use strict';
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { handleMercadoPagoWebhook } = require('./mercadopagoWebhook');
const { createTransferMonitor } = require('./transferMonitor');
const eventStore = require('./eventStore');
const { getDb } = require('./db');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Inicialización DB (eager — falla rápido si hay problema)
// ---------------------------------------------------------------------------
try {
  getDb();
  console.log('[db] SQLite listo');
} catch (e) {
  console.error('[db] No se pudo inicializar la base de datos:', e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Servidor HTTP + Socket.io
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Funciones de utilidad
// ---------------------------------------------------------------------------

function nuevoId() {
  return crypto.randomUUID();
}

function parseMonto(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim().replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function strOEmpty(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function secretConfigured(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Deriva el nombre del provider desde el campo "origen" de la alerta.
 * Usado para construir la clave de idempotencia cuando no viene explícito.
 */
function derivarProvider(origen) {
  const o = String(origen || '');
  if (o.includes('mercadopago')) return 'mercadopago';
  if (o.includes('prueba')) return 'prueba';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// emitirAlerta — punto central de deduplicación + persistencia + Socket.io
// ---------------------------------------------------------------------------

/**
 * Emite una alerta a todos los clientes Socket.io conectados.
 * Antes de emitir:
 *  1. Deduplica contra la DB (cross-sesión, cross-fuente).
 *  2. Persiste el evento con el modelo completo.
 *
 * Campos especiales (stripped antes de emitir al cliente):
 *   alerta._source_event_id   — ID de la plataforma de origen (ej: payment_id de MP)
 *   alerta._provider          — nombre del provider ('mercadopago', 'prueba', ...)
 *   alerta._idempotency_key   — clave de idempotencia explícita (opcional; se infiere si falta)
 *   alerta._payload_crudo     — payload original (se guarda en DB, no se emite)
 *
 * @returns {{ emitido: boolean, duplicate?: boolean }}
 */
function emitirAlerta(alerta, contextoLog) {
  // --- Extraer metadatos internos ---
  const sourceEventId = alerta._source_event_id || null;
  const provider = alerta._provider || derivarProvider(alerta.origen);
  const payloadCrudo = alerta._payload_crudo || null;

  // Idempotency key: si hay source_event_id (pago real), usamos clave basada en él.
  // Así webhook y monitor que detectan el mismo pago comparten la misma clave.
  const idempotencyKey =
    alerta._idempotency_key ||
    (sourceEventId
      ? eventStore.makeIdempotencyKey(provider, sourceEventId)
      : alerta.id); // fallback: UUID (siempre único → nunca dedup, útil para pruebas)

  // --- Alerta limpia para el cliente (sin campos internos) ---
  const paraClientes = {
    id:       alerta.id,
    monto:    alerta.monto,
    moneda:   alerta.moneda || 'ARS',
    mensaje:  alerta.mensaje  || '',
    fecha:    alerta.fecha,
    origen:   alerta.origen,
    titular:  alerta.titular  || 'Titular no informado',
    provider: provider,
    visto:    false,
  };

  // --- Persistir en DB ---
  let savedDuplicate = false;
  try {
    const result = eventStore.saveEvento({
      id:               alerta.id,
      provider:         provider,
      source_event_id:  sourceEventId,
      tipo:             'payment',
      estado:           'approved',
      monto:            alerta.monto,
      moneda:           alerta.moneda || 'ARS',
      mensaje:          alerta.mensaje || null,
      titular:          alerta.titular || null,
      fecha_evento:     alerta.fecha,
      payload_crudo:    payloadCrudo,
      idempotency_key:  idempotencyKey,
      alerta_emitida_at: new Date().toISOString(),
      origen:           alerta.origen,
    });

    if (result.duplicate) {
      console.log('[alertas] duplicado DB, no se emite key=', idempotencyKey);
      return { emitido: false, duplicate: true };
    }
  } catch (e) {
    // DB falla → igual emitimos (no perder la alerta)
    console.error('[alertas] error al persistir (se emite igual):', e.message);
  }

  // --- Emitir por Socket.io ---
  console.log(
    '[alertas] emit nueva-transferencia',
    contextoLog || '',
    'id=', alerta.id,
    'monto=', alerta.monto,
    'origen=', alerta.origen
  );
  io.emit('nueva-transferencia', paraClientes);
  return { emitido: true };
}

// ---------------------------------------------------------------------------
// Monitor de transferencias (polling)
// ---------------------------------------------------------------------------

const transferMonitor = createTransferMonitor({ emitirAlerta });

// ---------------------------------------------------------------------------
// Rutas de salud y diagnóstico
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  let dbOk = false;
  try { getDb(); dbOk = true; } catch (_) {}
  res.json({
    ok: true,
    service: 'mp-alertas-recepcion',
    db: dbOk ? 'ok' : 'error',
    ts: new Date().toISOString(),
  });
});

app.get('/debug/env-safe', (req, res) => {
  const portRaw = process.env.PORT;
  res.json({
    ok: true,
    port: portRaw === undefined || portRaw === '' ? null : String(portRaw),
    accessTokenConfigured:      secretConfigured('MP_ACCESS_TOKEN'),
    webhookSecretConfigured:    secretConfigured('MP_WEBHOOK_SECRET'),
    signatureValidationEnabled: envBool('MP_USE_SIGNATURE_VALIDATION', false),
    nodeEnv: process.env.NODE_ENV || null,
    dbPath: process.env.DB_PATH || '(default: ./data/alertas.db)',
  });
});

app.get('/debug/transfer-monitor', (req, res) => {
  try { res.json(transferMonitor.getSnapshot()); }
  catch (e) { res.status(500).json({ ok: false, error: 'snapshot' }); }
});

app.post('/debug/transfer-monitor/run-once', async (req, res) => {
  try { res.json(await transferMonitor.runOnce()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

// Alias account-movement
app.get('/debug/account-movement-monitor', (req, res) => {
  try { res.json(transferMonitor.getSnapshot()); }
  catch (e) { res.status(500).json({ ok: false, error: 'snapshot' }); }
});

app.post('/debug/account-movement-monitor/run-once', async (req, res) => {
  try { res.json(await transferMonitor.runOnce()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

// ---------------------------------------------------------------------------
// Webhook Mercado Pago
// ---------------------------------------------------------------------------

const webhookPaymentEnabled = envBool('MP_WEBHOOK_PAYMENT_ENABLED', true);

app.post('/webhooks/mercadopago', async (req, res) => {
  if (!webhookPaymentEnabled) {
    console.log('[webhook] deshabilitado por MP_WEBHOOK_PAYMENT_ENABLED=false');
    return res.status(200).json({ ok: true, ignored: true, reason: 'webhook deshabilitado' });
  }
  try {
    await handleMercadoPagoWebhook(req, res, { emitirAlerta, nuevoId });
  } catch (e) {
    console.error('[webhook] excepción no manejada:', e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ---------------------------------------------------------------------------
// API: alertas de prueba manual
// ---------------------------------------------------------------------------

app.post('/api/alerta-prueba', (req, res) => {
  console.log('[api] POST /api/alerta-prueba body:', req.body);
  try {
    const body = req.body;
    if (body === null || body === undefined || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Body JSON inválido o vacío' });
    }
    const monto = parseMonto(body.monto);
    if (monto === null) {
      return res.status(400).json({ ok: false, error: 'monto es requerido y debe ser número válido' });
    }
    const id = nuevoId();
    const alerta = {
      id,
      monto,
      moneda:  'ARS',
      mensaje: strOEmpty(body.mensaje) || 'Alerta de prueba',
      fecha:   new Date().toISOString(),
      origen:  'api.prueba',
      titular: strOEmpty(body.titular),
      // Prueba: no tiene source_event_id → idempotency_key = id (siempre único)
      _provider: 'prueba',
    };
    emitirAlerta(alerta, 'prueba-manual');
    return res.status(200).json({ ok: true, alerta: { id, monto, mensaje: alerta.mensaje, titular: alerta.titular } });
  } catch (e) {
    console.error('[api] alerta-prueba excepción:', e);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ---------------------------------------------------------------------------
// API REST: eventos (historial persistente)
// ---------------------------------------------------------------------------

/**
 * GET /api/eventos?limit=50&soloNoVistos=false
 * Retorna los últimos eventos ordenados por fecha descendente.
 */
app.get('/api/eventos', (req, res) => {
  try {
    const limit = Math.min(
      parseInt(req.query.limit, 10) || 50,
      200
    );
    const soloNoVistos = req.query.soloNoVistos === 'true';
    const eventos = eventStore.getEventos({ limit, soloNoVistos });
    res.json({ ok: true, eventos, total: eventos.length });
  } catch (e) {
    console.error('[api] GET /api/eventos error:', e.message);
    res.status(500).json({ ok: false, error: 'Error al obtener eventos' });
  }
});

/**
 * GET /api/eventos/:id
 * Retorna un evento por ID interno.
 */
app.get('/api/eventos/:id', (req, res) => {
  try {
    const evento = eventStore.getEventoById(req.params.id);
    if (!evento) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, evento });
  } catch (e) {
    console.error('[api] GET /api/eventos/:id error:', e.message);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

/**
 * PATCH /api/eventos/:id/visto
 * Marca un evento como visto.
 */
app.patch('/api/eventos/:id/visto', (req, res) => {
  try {
    const ok = eventStore.markVisto(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'No encontrado' });
    // Notifica a todos los clientes para sincronizar estado
    io.emit('evento-visto', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[api] PATCH /api/eventos/:id/visto error:', e.message);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ---------------------------------------------------------------------------
// Socket.io — al conectar, envía historial de la DB al cliente
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log('[socket] conectado id=', socket.id);

  // Envía el historial al cliente recién conectado (solo a él, no broadcast)
  try {
    const eventos = eventStore.getEventos({ limit: 50 });
    socket.emit('historial-eventos', eventos);
  } catch (e) {
    console.error('[socket] error enviando historial:', e.message);
  }

  socket.on('disconnect', (reason) => {
    console.log('[socket] desconectado id=', socket.id, 'reason=', reason);
  });
});

// ---------------------------------------------------------------------------
// Archivos estáticos (frontend)
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`[servidor] http://localhost:${PORT}`);
  console.log('[servidor] GET  /health');
  console.log('[servidor] GET  /debug/env-safe');
  console.log('[servidor] GET  /debug/transfer-monitor (alias account-movement)');
  console.log('[servidor] POST /debug/transfer-monitor/run-once');
  console.log('[servidor] POST /webhooks/mercadopago');
  console.log('[servidor] POST /api/alerta-prueba');
  console.log('[servidor] GET  /api/eventos');
  console.log('[servidor] GET  /api/eventos/:id');
  console.log('[servidor] PATCH /api/eventos/:id/visto');
  console.log(`[servidor] MP_WEBHOOK_PAYMENT_ENABLED=${webhookPaymentEnabled}`);
  transferMonitor.start();
});
