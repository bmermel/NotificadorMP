'use strict';
/**
 * Tests de idempotencia y deduplicación del eventStore.
 * Usa SQLite en memoria (:memory:) para no tocar archivos.
 */

const Database = require('better-sqlite3');

// Configurar DB en memoria ANTES de requerir eventStore o db.js
process.env.DB_PATH = ':memory:';

const { getDb, _setDb } = require('../db');

// Inicializa una DB en memoria limpia para cada test suite
let memDb;
beforeAll(() => {
  memDb = new Database(':memory:');
  _setDb(memDb);

  // Crear schema
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL DEFAULT 'unknown',
      source_event_id TEXT,
      tipo TEXT NOT NULL DEFAULT 'payment',
      estado TEXT NOT NULL DEFAULT 'approved',
      monto REAL NOT NULL,
      moneda TEXT NOT NULL DEFAULT 'ARS',
      mensaje TEXT,
      titular TEXT,
      referencia TEXT,
      fecha_evento TEXT NOT NULL,
      payload_crudo TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      alerta_emitida_at TEXT,
      visto INTEGER NOT NULL DEFAULT 0,
      origen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
});

afterAll(() => {
  if (memDb) memDb.close();
});

const eventStore = require('../eventStore');

function makeEvento(overrides = {}) {
  return {
    id:               'test-id-' + Math.random().toString(36).slice(2),
    provider:         'mercadopago',
    source_event_id:  '12345',
    tipo:             'payment',
    estado:           'approved',
    monto:            5000,
    moneda:           'ARS',
    mensaje:          'Transferencia recibida',
    titular:          'Juan Perez',
    fecha_evento:     new Date().toISOString(),
    idempotency_key:  'mercadopago:payment:12345',
    origen:           'webhook.mercadopago',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveEvento — inserción básica
// ---------------------------------------------------------------------------

describe('saveEvento', () => {
  test('guarda un evento nuevo y retorna saved=true', () => {
    const ev = makeEvento({ idempotency_key: 'mp:payment:unique-1' });
    const result = eventStore.saveEvento(ev);
    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.evento).toBeDefined();
  });

  test('segundo insert con misma idempotency_key retorna duplicate=true', () => {
    const key = 'mp:payment:dup-test-' + Date.now();
    const ev1 = makeEvento({ id: 'id-a', idempotency_key: key });
    const ev2 = makeEvento({ id: 'id-b', idempotency_key: key });

    const r1 = eventStore.saveEvento(ev1);
    const r2 = eventStore.saveEvento(ev2);

    expect(r1.saved).toBe(true);
    expect(r2.saved).toBe(false);
    expect(r2.duplicate).toBe(true);
  });

  test('eventos con distintas idempotency_key se guardan de forma independiente', () => {
    const r1 = eventStore.saveEvento(makeEvento({ id: 'id-x', idempotency_key: 'mp:payment:x1' }));
    const r2 = eventStore.saveEvento(makeEvento({ id: 'id-y', idempotency_key: 'mp:payment:x2' }));

    expect(r1.saved).toBe(true);
    expect(r2.saved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  test('retorna false para clave nueva', () => {
    expect(eventStore.isDuplicate('mp:payment:never-seen')).toBe(false);
  });

  test('retorna true tras guardar con esa clave', () => {
    const key = 'mp:payment:dup-check-' + Date.now();
    eventStore.saveEvento(makeEvento({ id: 'id-dc-' + Date.now(), idempotency_key: key }));
    expect(eventStore.isDuplicate(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// makeIdempotencyKey
// ---------------------------------------------------------------------------

describe('makeIdempotencyKey', () => {
  test('combina provider y sourceEventId', () => {
    expect(eventStore.makeIdempotencyKey('mercadopago', '99999')).toBe('mercadopago:payment:99999');
  });

  test('misma clave para webhook y monitor del mismo pago', () => {
    const k1 = eventStore.makeIdempotencyKey('mercadopago', '12345');
    const k2 = eventStore.makeIdempotencyKey('mercadopago', '12345');
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// markVisto
// ---------------------------------------------------------------------------

describe('markVisto', () => {
  test('marca como visto y retorna true', () => {
    const key = 'mp:payment:visto-test-' + Date.now();
    const ev = makeEvento({ id: 'id-v-' + Date.now(), idempotency_key: key });
    eventStore.saveEvento(ev);

    const ok = eventStore.markVisto(ev.id);
    expect(ok).toBe(true);

    const found = eventStore.getEventoById(ev.id);
    expect(found.visto).toBe(true);
  });

  test('retorna false para id inexistente', () => {
    expect(eventStore.markVisto('id-que-no-existe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEventos
// ---------------------------------------------------------------------------

describe('getEventos', () => {
  test('retorna array de eventos', () => {
    const eventos = eventStore.getEventos({ limit: 100 });
    expect(Array.isArray(eventos)).toBe(true);
  });

  test('respeta el límite', () => {
    const eventos = eventStore.getEventos({ limit: 2 });
    expect(eventos.length).toBeLessThanOrEqual(2);
  });
});
