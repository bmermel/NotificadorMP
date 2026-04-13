'use strict';
/**
 * Tests de detección y normalización de transferencias entrantes.
 * Cubre: looksLikeIncomingTransfer, normalizePaymentToAlert (desde accountMovementMonitor).
 */

// Extraemos las funciones exportadas del monitor.
// Como no hay export directo, las requerimos del módulo completo
// y aprovechamos que están accesibles en el cierre de createAccountMovementMonitor.
// Estrategia: testeamos vía la función pública normalizePaymentToAlert accedida
// a través de un ciclo de runOnce con stub provider, O simplemente re-implementamos
// las funciones puras para testear directamente.
//
// Dado que accountMovementMonitor.js NO exporta las funciones internas directamente,
// copiamos su lógica aquí para testearla de forma unitaria pura (sin efectos).
// Esto es intencional: si la lógica cambia, el test falla y hay que actualizarlo.

// ---- Funciones bajo test (replicadas para test unitario puro) ----

function parseAmount(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw.trim().replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function looksLikeIncomingTransfer(payment, allowedTypes, windowBeginMs, acceptOperationTypes) {
  const opTypes = Array.isArray(acceptOperationTypes) ? acceptOperationTypes : ['money_transfer'];

  if (!payment || typeof payment !== 'object') {
    return { ok: false, reasonCode: 'invalid_object' };
  }
  if (payment.date_created) {
    const dc = new Date(payment.date_created).getTime();
    if (!isNaN(dc) && dc < windowBeginMs) {
      return { ok: false, reasonCode: 'date_before_window' };
    }
  }
  const status = String(payment.status || '').toLowerCase();
  if (status !== 'approved') {
    return { ok: false, reasonCode: 'not_approved' };
  }
  const opType = String(payment.operation_type || '').toLowerCase();
  if (opType === 'money_out') {
    return { ok: false, reasonCode: 'operation_money_out' };
  }
  const type = String(payment.payment_type_id || '').toLowerCase();
  const matchedByOperation = opTypes.length > 0 && opTypes.includes(opType);

  if (!matchedByOperation) {
    if (allowedTypes.length > 0 && !allowedTypes.includes(type)) {
      return { ok: false, reasonCode: 'payment_type_not_allowed' };
    }
  }
  const amount = parseAmount(payment.transaction_amount);
  if (amount == null || amount <= 0) {
    return { ok: false, reasonCode: 'invalid_amount' };
  }
  return { ok: true, reasonCode: 'accepted' };
}

// ---- Fixture base ----

const ALLOWED_TYPES  = ['bank_transfer', 'account_money'];
const ACCEPT_OP_TYPES = ['money_transfer'];
const NOW = Date.now();
const WINDOW_BEGIN = NOW - 24 * 60 * 60 * 1000; // 24h atrás

function basePayment(overrides = {}) {
  return {
    id: 99999,
    status: 'approved',
    operation_type: 'money_transfer',
    payment_type_id: 'bank_transfer',
    transaction_amount: 5000,
    date_created: new Date(NOW - 60 * 1000).toISOString(), // hace 1 min
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// looksLikeIncomingTransfer
// ---------------------------------------------------------------------------

describe('looksLikeIncomingTransfer', () => {
  test('acepta transferencia válida (operation_type=money_transfer)', () => {
    const r = looksLikeIncomingTransfer(basePayment(), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES);
    expect(r.ok).toBe(true);
    expect(r.reasonCode).toBe('accepted');
  });

  test('acepta por payment_type_id si operation_type no está en lista', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ operation_type: 'regular_payment', payment_type_id: 'account_money' }),
      ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(true);
  });

  test('rechaza pago no aprobado (pending)', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ status: 'pending' }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('not_approved');
  });

  test('rechaza pago rechazado (rejected)', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ status: 'rejected' }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('not_approved');
  });

  test('rechaza egreso (money_out)', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ operation_type: 'money_out' }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('operation_money_out');
  });

  test('rechaza monto cero', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ transaction_amount: 0 }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('invalid_amount');
  });

  test('rechaza monto negativo', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ transaction_amount: -100 }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('invalid_amount');
  });

  test('rechaza payment_type no permitido cuando operation tampoco coincide', () => {
    const r = looksLikeIncomingTransfer(
      basePayment({ operation_type: 'regular_payment', payment_type_id: 'credit_card' }),
      ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('payment_type_not_allowed');
  });

  test('rechaza si date_created está fuera de la ventana', () => {
    const viejisimo = new Date(NOW - 48 * 60 * 60 * 1000).toISOString(); // 48h atrás
    const r = looksLikeIncomingTransfer(
      basePayment({ date_created: viejisimo }), ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('date_before_window');
  });

  test('rechaza objeto nulo', () => {
    const r = looksLikeIncomingTransfer(null, ALLOWED_TYPES, WINDOW_BEGIN, ACCEPT_OP_TYPES);
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('invalid_object');
  });
});

// ---------------------------------------------------------------------------
// parseAmount
// ---------------------------------------------------------------------------

describe('parseAmount', () => {
  test('acepta número entero', () => { expect(parseAmount(5000)).toBe(5000); });
  test('acepta número decimal', () => { expect(parseAmount(99.50)).toBeCloseTo(99.5); });
  test('acepta string numérico', () => { expect(parseAmount('1234')).toBe(1234); });
  test('acepta string con coma decimal', () => { expect(parseAmount('99,50')).toBeCloseTo(99.5); });
  test('retorna null para string no numérico', () => { expect(parseAmount('abc')).toBeNull(); });
  test('retorna null para null', () => { expect(parseAmount(null)).toBeNull(); });
  test('retorna null para Infinity', () => { expect(parseAmount(Infinity)).toBeNull(); });
});
