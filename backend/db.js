'use strict';
/**
 * Inicialización de la base de datos SQLite (better-sqlite3).
 * Singleton: getDb() retorna siempre la misma instancia.
 * Llama getDb() en cualquier módulo; la DB se crea al primer uso.
 *
 * Variables de entorno:
 *   DB_PATH  — ruta al archivo .db (default: ./data/alertas.db)
 *              Usar ":memory:" para tests en RAM.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dbDir = path.resolve(path.join(__dirname, 'data'));
  const dbPath = process.env.DB_PATH || path.join(dbDir, 'alertas.db');

  // Solo crea el directorio si no es :memory:
  if (dbPath !== ':memory:' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath);

  // Modo WAL: escrituras sin bloquear lecturas, muy bueno para este caso
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS eventos (
      id                TEXT PRIMARY KEY NOT NULL,
      provider          TEXT NOT NULL DEFAULT 'unknown',
      source_event_id   TEXT,
      tipo              TEXT NOT NULL DEFAULT 'payment',
      estado            TEXT NOT NULL DEFAULT 'approved',
      monto             REAL NOT NULL,
      moneda            TEXT NOT NULL DEFAULT 'ARS',
      mensaje           TEXT,
      titular           TEXT,
      referencia        TEXT,
      fecha_evento      TEXT NOT NULL,
      payload_crudo     TEXT,
      idempotency_key   TEXT UNIQUE NOT NULL,
      alerta_emitida_at TEXT,
      visto             INTEGER NOT NULL DEFAULT 0,
      origen            TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eventos_fecha      ON eventos(fecha_evento DESC);
    CREATE INDEX IF NOT EXISTS idx_eventos_visto      ON eventos(visto);
    CREATE INDEX IF NOT EXISTS idx_eventos_provider   ON eventos(provider);
    CREATE INDEX IF NOT EXISTS idx_eventos_idem       ON eventos(idempotency_key);

    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at     TEXT NOT NULL,
      completed_at   TEXT,
      provider       TEXT NOT NULL,
      fetched_count  INTEGER DEFAULT 0,
      accepted_count INTEGER DEFAULT 0,
      rejected_count INTEGER DEFAULT 0,
      error          TEXT,
      audit_json     TEXT
    );
  `);

  return _db;
}

function closeDb() {
  if (_db) {
    try { _db.close(); } catch (_) {}
    _db = null;
  }
}

/** Solo para tests: reemplaza la instancia activa (permite inyectar :memory:). */
function _setDb(instance) {
  _db = instance;
}

module.exports = { getDb, closeDb, _setDb };
