'use strict';
/**
 * Tests de la lógica de firma y parsing del webhook de Mercado Pago.
 * Cubre: parseXSignature, construirManifest, validarFirmaWebhook,
 *        obtenerTipoNotificacion, obtenerPaymentId.
 */

const {
  _internal: {
    parseXSignature,
    construirManifest,
    validarFirmaWebhook,
    obtenerTipoNotificacion,
    obtenerPaymentId,
  },
} = require('../mercadopagoWebhook');

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// parseXSignature
// ---------------------------------------------------------------------------

describe('parseXSignature', () => {
  test('parsea ts y v1 correctamente', () => {
    const result = parseXSignature('ts=1715000000,v1=abc123def456');
    expect(result.ts).toBe('1715000000');
    expect(result.v1).toBe('abc123def456');
  });

  test('maneja espacios alrededor de = y ,', () => {
    const result = parseXSignature('ts = 111 , v1 = aaa');
    expect(result.ts).toBe('111');
    expect(result.v1).toBe('aaa');
  });

  test('retorna nulls si falta el header', () => {
    const result = parseXSignature(null);
    expect(result.ts).toBeNull();
    expect(result.v1).toBeNull();
  });

  test('retorna nulls si el formato es inválido', () => {
    const result = parseXSignature('malformado');
    expect(result.ts).toBeNull();
    expect(result.v1).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// construirManifest
// ---------------------------------------------------------------------------

describe('construirManifest', () => {
  test('construye manifest completo', () => {
    const m = construirManifest({ idParaFirma: '12345', requestId: 'req-abc', ts: '1715000000' });
    expect(m).toBe('id:12345;request-id:req-abc;ts:1715000000;');
  });

  test('omite partes vacías', () => {
    const m = construirManifest({ idParaFirma: '', requestId: 'req-abc', ts: '111' });
    expect(m).toBe('request-id:req-abc;ts:111;');
  });

  test('solo ts si faltan id y requestId', () => {
    const m = construirManifest({ idParaFirma: null, requestId: null, ts: '999' });
    expect(m).toBe('ts:999;');
  });
});

// ---------------------------------------------------------------------------
// validarFirmaWebhook
// ---------------------------------------------------------------------------

describe('validarFirmaWebhook', () => {
  const secret = 'my-secret-key-test';

  function firmar(manifest) {
    return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  }

  test('valida firma correcta', () => {
    const manifest = 'id:12345;request-id:req-1;ts:111;';
    const v1Hex = firmar(manifest);
    expect(validarFirmaWebhook({ secret, manifest, v1Hex })).toBe(true);
  });

  test('rechaza firma incorrecta', () => {
    const manifest = 'id:12345;request-id:req-1;ts:111;';
    expect(validarFirmaWebhook({ secret, manifest, v1Hex: 'deadbeef' })).toBe(false);
  });

  test('rechaza si secret vacío', () => {
    expect(validarFirmaWebhook({ secret: '', manifest: 'test;', v1Hex: 'aaa' })).toBe(false);
  });

  test('rechaza si v1Hex vacío', () => {
    expect(validarFirmaWebhook({ secret, manifest: 'test;', v1Hex: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// obtenerTipoNotificacion
// ---------------------------------------------------------------------------

describe('obtenerTipoNotificacion', () => {
  test('extrae type del body', () => {
    expect(obtenerTipoNotificacion({ type: 'payment' }, {})).toBe('payment');
  });

  test('extrae topic del body si no hay type', () => {
    expect(obtenerTipoNotificacion({ topic: 'payment' }, {})).toBe('payment');
  });

  test('extrae type de query si no está en body', () => {
    expect(obtenerTipoNotificacion({}, { type: 'payment' })).toBe('payment');
  });

  test('retorna null si no hay nada', () => {
    expect(obtenerTipoNotificacion({}, {})).toBeNull();
  });

  test('normaliza a lowercase', () => {
    expect(obtenerTipoNotificacion({ type: 'PAYMENT' }, {})).toBe('payment');
  });
});

// ---------------------------------------------------------------------------
// obtenerPaymentId
// ---------------------------------------------------------------------------

describe('obtenerPaymentId', () => {
  test('extrae de body.data.id (numérico)', () => {
    expect(obtenerPaymentId({ data: { id: 123456 } }, {})).toBe('123456');
  });

  test('extrae de body.data.id (string)', () => {
    expect(obtenerPaymentId({ data: { id: '999' } }, {})).toBe('999');
  });

  test('extrae de query data.id', () => {
    expect(obtenerPaymentId({}, { 'data.id': '777' })).toBe('777');
  });

  test('extrae de query id cuando topic=payment (formato legacy)', () => {
    expect(obtenerPaymentId({}, { topic: 'payment', id: '555' })).toBe('555');
  });

  test('retorna null si no hay id', () => {
    expect(obtenerPaymentId({}, {})).toBeNull();
  });
});
