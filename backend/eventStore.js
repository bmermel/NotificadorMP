'use strict';
/**
 * Capa de persistencia de eventos/alertas.
 *
 * Conceptos:
 *  - evento: una acreditación detectada (de webhook o monitor).
 *  - idempotency_key: clave única que previene duplicados cross-sesión.
 *    Formato: "<provider>:payment:<source_event_id>"  →  "mercadopago:payment:12345"
 *    Los eventos de prueba usan el id interno (UUID) como clave: nunca se deduplicam.
 *
 * Toda lógica de negocio de persistencia vive aquí.
 * Los módulos de transporte (webhook, monitor, server) solo llaman a estas funciones.
 */

const { getDb } = require('./db');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

/**
 * Genera la clave de idempotencia para un pago de Mercado Pago.
 * Misma clave si vino del webhook o del monitor → deduplicación cruzada.
 */
function makeIdempotencyKey(provider, sourceEventId) {
  return `${String(provider)}:payment:${String(sourceEventId)}`;
}

/**
 * Serializa un row de la DB al formato que entiende el frontend (Socket.io / API REST).
 * Omite payload_crudo (puede ser grande).
 */
function serializarEvento(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    source_event_id: row.source_event_id || null,
    tipo: row.tipo,
    estado: row.estado,
    monto: row.monto,
    moneda: row.moneda || 'ARS',
    mensaje: row.mensaje || '',
    titular: row.titular || 'Titular no informado',
    referencia: row.referencia || null,
    fecha: row.fecha_evento,      // alias para compatibilidad con frontend existente
    fecha_evento: row.fecha_evento,
    origen: row.origen,
    idempotency_key: row.idempotency_key,
    alerta_emitida_at: row.alerta_emitida_at || null,
    visto: row.visto === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/**
 * Guarda un evento en la DB.
 * Si ya existe un evento con el mismo idempotency_key → retorna duplicate=true.
 *
 * @param {object} data
 * @param {string} data.id               - UUID interno
 * @param {string} data.provider         - 'mercadopago' | 'prueba' | ...
 * @param {string} [data.source_event_id] - ID en la plataforma de origen (ej: payment_id de MP)
 * @param {string} [data.tipo]           - 'payment' | ...
 * @param {string} [data.estado]         - 'approved' | ...
 * @param {number} data.monto
 * @param {string} [data.moneda]         - 'ARS' | ...
 * @param {string} [data.mensaje]
 * @param {string} [data.titular]
 * @param {string} [data.referencia]
 * @param {string} data.fecha_evento     - ISO 8601
 * @param {object} [data.payload_crudo]  - Payload original (se guarda como JSON string)
 * @param {string} data.idempotency_key
 * @param {string} [data.alerta_emitida_at]
 * @param {string} data.origen           - 'webhook.mercadopago' | 'monitor.transferencias' | 'api.prueba'
 * @returns {{ saved: boolean, duplicate: boolean, evento: object }}
 */
function saveEvento(data) {
  const db = getDb();
  const n = now();

  const row = {
    id:                 data.id,
    provider:           data.provider          || 'unknown',
    source_event_id:    data.source_event_id   || null,
    tipo:               data.tipo              || 'payment',
    estado:             data.estado            || 'approved',
    monto:              data.monto,
    moneda:             data.moneda            || 'ARS',
    mensaje:            data.mensaje           || null,
    titular:            data.titular           || null,
    referencia:         data.referencia        || null,
    fecha_evento:       data.fecha_evento      || n,
    payload_crudo:      data.payload_crudo != null
                          ? JSON.stringify(data.payload_crudo)
                          : null,
    idempotency_key:    data.idempotency_key   || data.id,
    alerta_emitida_at:  data.alerta_emitida_at || null,
    visto:              0,
    origen:             data.origen            || data.provider || 'unknown',
    created_at:         n,
    updated_at:         n,
  };

  try {
    db.prepare(`
      INSERT INTO eventos (
        id, provider, source_event_id, tipo, estado, monto, moneda, mensaje,
        titular, referencia, fecha_evento, payload_crudo, idempotency_key,
        alerta_emitida_at, visto, origen, created_at, updated_at
      ) VALUES (
        @id, @provider, @source_event_id, @tipo, @estado, @monto, @moneda, @mensaje,
        @titular, @referencia, @fecha_evento, @payload_crudo, @idempotency_key,
        @alerta_emitida_at, @visto, @origen, @created_at, @updated_at
      )
    `).run(row);
    return { saved: true, duplicate: false, evento: serializarEvento(row) };
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
      const existing = db.prepare(
        'SELECT * FROM eventos WHERE idempotency_key = ?'
      ).get(row.idempotency_key);
      return { saved: false, duplicate: true, evento: serializarEvento(existing) };
    }
    throw e;
  }
}

/**
 * Registra cuándo se emitió la alerta para un evento ya guardado.
 */
function markAlertaEmitida(id) {
  const db = getDb();
  db.prepare(
    'UPDATE eventos SET alerta_emitida_at = ?, updated_at = ? WHERE id = ?'
  ).run(now(), now(), id);
}

// ---------------------------------------------------------------------------
// Estado de lectura
// ---------------------------------------------------------------------------

/**
 * Marca un evento como visto. Retorna true si se actualizó.
 */
function markVisto(id) {
  const db = getDb();
  const r = db.prepare(
    'UPDATE eventos SET visto = 1, updated_at = ? WHERE id = ?'
  ).run(now(), id);
  return r.changes > 0;
}

/**
 * Lista los últimos eventos ordenados por fecha descendente.
 * @param {{ limit?: number, soloNoVistos?: boolean }} opts
 */
function getEventos({ limit = 50, soloNoVistos = false } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM eventos';
  if (soloNoVistos) sql += ' WHERE visto = 0';
  sql += ' ORDER BY fecha_evento DESC, created_at DESC LIMIT ?';
  return db.prepare(sql).all(limit).map(serializarEvento);
}

/**
 * Obtiene un evento por ID interno.
 */
function getEventoById(id) {
  const row = getDb().prepare('SELECT * FROM eventos WHERE id = ?').get(id);
  return serializarEvento(row);
}

/**
 * Verifica si ya existe un evento con esa clave de idempotencia.
 * Rápido: solo trae el id.
 */
function isDuplicate(idempotencyKey) {
  const row = getDb().prepare(
    'SELECT id FROM eventos WHERE idempotency_key = ?'
  ).get(idempotencyKey);
  return !!row;
}

// ---------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------

/**
 * Guarda el resultado de un ciclo de reconciliación/polling.
 * @param {{ started_at, completed_at, provider, fetched_count, accepted_count, rejected_count, error?, audit_json? }} run
 */
function saveReconciliationRun(run) {
  return getDb().prepare(`
    INSERT INTO reconciliation_runs
      (started_at, completed_at, provider, fetched_count, accepted_count, rejected_count, error, audit_json)
    VALUES
      (@started_at, @completed_at, @provider, @fetched_count, @accepted_count, @rejected_count, @error, @audit_json)
  `).run(run).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  saveEvento,
  markAlertaEmitida,
  markVisto,
  getEventos,
  getEventoById,
  isDuplicate,
  makeIdempotencyKey,
  saveReconciliationRun,
  serializarEvento,
};
