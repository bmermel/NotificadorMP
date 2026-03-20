/**
 * Integración Mercado Pago — Webhooks (notificaciones payment) + API de pagos.
 *
 * Formato soportado (documentación oficial "Your integrations" — topic payment):
 * Body JSON típico:
 * {
 *   "id": 12345,
 *   "live_mode": true,
 *   "type": "payment",
 *   "date_created": "...",
 *   "user_id": 44444,
 *   "api_version": "v1",
 *   "action": "payment.created",
 *   "data": { "id": "999999999" }
 * }
 *
 * Variantes defensivas:
 * - type/topic en body o query (?topic=payment)
 * - data.id numérico o string; id de pago también en query legacy (?id=&topic=payment)
 * - Query data.id para firma (recomendado por MP) y/o fallback desde body.data.id
 *
 * Firma (si MP_USE_SIGNATURE_VALIDATION=true y MP_WEBHOOK_SECRET):
 * - Headers: x-signature (ts=...,v1=...), x-request-id
 * - Manifest: id:[data.id en minúsculas si es alfanumérico];request-id:[x-request-id];ts:[ts];
 * - HMAC SHA256 hex con el secret; comparar con v1
 */

const crypto = require("crypto");
const https = require("https");

/** IDs de pago por los que ya se emitió alerta (evita duplicados por reintentos MP). */
const pagosYaAlertados = new Set();

function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return String(v).toLowerCase() === "true" || v === "1";
}

/**
 * Parsea x-signature: "ts=...,v1=..."
 */
function parseXSignature(header) {
  if (!header || typeof header !== "string") return { ts: null, v1: null };
  const parts = header.split(",");
  let ts = null;
  let v1 = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "v1") v1 = value;
  }
  return { ts, v1 };
}

/**
 * id para el manifest: si es alfanumérico, minúsculas (doc MP).
 */
function normalizarIdManifest(id) {
  if (id == null) return "";
  const s = String(id).trim();
  if (/^[a-zA-Z0-9]+$/.test(s)) return s.toLowerCase();
  return s;
}

/**
 * Construye la cadena firmada según plantilla oficial.
 * Si falta algún componente, se omite ese fragmento (doc: quitar parámetros ausentes).
 */
function construirManifest({ idParaFirma, requestId, ts }) {
  const partes = [];
  if (idParaFirma !== undefined && idParaFirma !== null && String(idParaFirma) !== "") {
    partes.push("id:" + idParaFirma);
  }
  if (requestId) partes.push("request-id:" + requestId);
  if (ts) partes.push("ts:" + ts);
  return partes.join(";") + ";";
}

function validarFirmaWebhook({ secret, manifest, v1Hex }) {
  if (!secret || !v1Hex) return false;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(manifest);
  const esperado = hmac.digest("hex");
  if (esperado.length !== v1Hex.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(esperado, "hex"),
      Buffer.from(v1Hex, "hex")
    );
  } catch (_) {
    return false;
  }
}

/**
 * Extrae tipo de notificación (payment, merchant_order, etc.).
 */
function obtenerTipoNotificacion(body, query) {
  const q = query || {};
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.type === "string" && b.type.trim()) return b.type.trim().toLowerCase();
  if (typeof b.topic === "string" && b.topic.trim()) return b.topic.trim().toLowerCase();
  if (typeof q.type === "string" && q.type.trim()) return q.type.trim().toLowerCase();
  if (typeof q.topic === "string" && q.topic.trim()) return q.topic.trim().toLowerCase();
  return null;
}

/**
 * Extrae ID de pago desde body o query (defensivo).
 */
function obtenerPaymentId(body, query) {
  const q = query || {};
  const b = body && typeof body === "object" ? body : {};

  if (b.data != null && typeof b.data === "object" && b.data.id != null) {
    return String(b.data.id).trim();
  }
  if (q["data.id"] != null && String(q["data.id"]).trim() !== "") {
    return String(q["data.id"]).trim();
  }
  if (
    String(q.topic || "").toLowerCase() === "payment" &&
    q.id != null &&
    String(q.id).trim() !== ""
  ) {
    return String(q.id).trim();
  }
  if (typeof b.id !== "undefined" && b.id != null && String(b.id).trim() !== "") {
    return String(b.id).trim();
  }
  return null;
}

/**
 * id usado en el manifest de firma: prioriza query data.id (doc MP), si no body.data.id.
 */
function obtenerIdParaFirma(body, query, paymentIdFallback) {
  const q = query || {};
  if (q["data.id"] != null && String(q["data.id"]).trim() !== "") {
    return normalizarIdManifest(q["data.id"]);
  }
  if (paymentIdFallback) return normalizarIdManifest(paymentIdFallback);
  return "";
}

function titularDesdePago(payer) {
  if (!payer || typeof payer !== "object") return "Titular no informado";
  const fn = String(payer.first_name || "").trim();
  const ln = String(payer.last_name || "").trim();
  const nombre = [fn, ln].filter(Boolean).join(" ").trim();
  if (nombre) return nombre;
  const email = payer.email != null ? String(payer.email).trim() : "";
  if (email) return email;
  return "Titular no informado";
}

/**
 * GET https://api.mercadopago.com/v1/payments/:id
 * Usa fetch (Node 18+) o https nativo como respaldo.
 */
function httpsGetJson(urlStr, headers) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: headers,
    };
    const req = https.request(opts, function (res) {
      var data = "";
      res.on("data", function (c) {
        data += c;
      });
      res.on("end", function () {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: function () {
            return Promise.resolve(data);
          },
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function consultarPagoEnMercadoPago(paymentId) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token || !String(token).trim()) {
    throw new Error("MP_ACCESS_TOKEN no configurado");
  }
  const url =
    "https://api.mercadopago.com/v1/payments/" +
    encodeURIComponent(paymentId);
  const hdr = {
    Authorization: "Bearer " + token.trim(),
    "Content-Type": "application/json",
  };

  var res;
  if (typeof fetch === "function") {
    res = await fetch(url, { method: "GET", headers: hdr });
  } else {
    res = await httpsGetJson(url, hdr);
  }

  const texto = await res.text();
  let json;
  try {
    json = texto ? JSON.parse(texto) : {};
  } catch (_) {
    json = { raw: texto };
  }
  const status = res.status;
  if (!res.ok) {
    const err = new Error("Mercado Pago API error HTTP " + status);
    err.status = status;
    err.body = json;
    throw err;
  }
  return json;
}

function montoDesdePago(pago) {
  const raw = pago && pago.transaction_amount;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim().replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function mapearPagoAAlerta(pago, paymentId) {
  const status = String(pago.status || "").toLowerCase();
  const monto = montoDesdePago(pago);
  const fecha =
    pago.date_approved ||
    pago.date_created ||
    pago.date_last_updated ||
    new Date().toISOString();
  const titular = titularDesdePago(pago.payer);
  const mensaje =
    status === "approved"
      ? "Pago aprobado Mercado Pago"
      : "Transferencia recibida";

  return {
    monto,
    mensaje,
    fecha:
      typeof fecha === "string" ? fecha : new Date(fecha).toISOString(),
    origen: "webhook.mercadopago",
    titular,
  };
}

/**
 * Procesa POST /webhooks/mercadopago. No lanza: responde siempre con HTTP controlado.
 */
async function handleMercadoPagoWebhook(req, res, { emitirAlerta, nuevoId }) {
  const body = req.body;
  const query = req.query || {};

  console.log("[mp-webhook] POST recibido query=", JSON.stringify(query));
  console.log("[mp-webhook] body (resumen tipo)=", typeof body, body && body.type);

  const tipo = obtenerTipoNotificacion(body, query);
  const paymentId = obtenerPaymentId(body, query);

  const usarFirma = envBool("MP_USE_SIGNATURE_VALIDATION", false);
  const secret = process.env.MP_WEBHOOK_SECRET
    ? String(process.env.MP_WEBHOOK_SECRET).trim()
    : "";

  const xSig =
    req.get("x-signature") ||
    req.get("X-Signature") ||
    req.headers["x-signature"];
  const xReqId =
    req.get("x-request-id") ||
    req.get("X-Request-Id") ||
    req.headers["x-request-id"];

  if (usarFirma) {
    if (!secret) {
      console.error("[mp-webhook] MP_USE_SIGNATURE_VALIDATION activo pero falta MP_WEBHOOK_SECRET");
      return res.status(503).json({
        ok: false,
        error: "Firma requerida pero secret no configurado",
      });
    }
    if (!xSig || !xReqId) {
      console.warn("[mp-webhook] firma requerida: faltan x-signature o x-request-id");
      return res.status(401).json({
        ok: false,
        error: "Cabeceras de firma requeridas",
      });
    }
    const { ts, v1 } = parseXSignature(xSig);
    if (!ts || !v1) {
      console.warn("[mp-webhook] x-signature inválido");
      return res.status(401).json({ ok: false, error: "x-signature inválido" });
    }
    const idParaFirma = obtenerIdParaFirma(body, query, paymentId);
    const manifest = construirManifest({
      idParaFirma,
      requestId: xReqId,
      ts,
    });
    const okFirma = validarFirmaWebhook({
      secret,
      manifest,
      v1Hex: v1,
    });
    console.log("[mp-webhook] manifest firmado:", manifest);
    console.log("[mp-webhook] firma válida:", okFirma);
    if (!okFirma) {
      return res.status(401).json({ ok: false, error: "Firma inválida" });
    }
  } else {
    console.log("[mp-webhook] validación de firma desactivada (MP_USE_SIGNATURE_VALIDATION!=true)");
  }

  if (!tipo) {
    console.log("[mp-webhook] sin tipo/topic reconocible → 200 ignorado");
    return res.status(200).json({ ok: true, ignored: true, reason: "sin tipo" });
  }

  if (tipo !== "payment") {
    console.log("[mp-webhook] tipo no es payment:", tipo, "→ 200 ignorado");
    return res
      .status(200)
      .json({ ok: true, ignored: true, reason: "tipo no es payment", tipo });
  }

  if (!paymentId) {
    console.warn("[mp-webhook] tipo payment pero sin id de pago → 200 ignorado");
    return res
      .status(200)
      .json({ ok: true, ignored: true, reason: "sin payment id" });
  }

  let pago;
  try {
    console.log("[mp-webhook] consultando pago id=", paymentId);
    pago = await consultarPagoEnMercadoPago(paymentId);
  } catch (e) {
    console.error("[mp-webhook] error API Mercado Pago:", e.message, e.body || "");
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({
      ok: false,
      error: "No se pudo obtener el pago en Mercado Pago",
      detalle: e.message,
    });
  }

  const statusPago = String(pago.status || "").toLowerCase();
  console.log("[mp-webhook] pago", paymentId, "status=", statusPago);

  if (statusPago !== "approved") {
    console.log("[mp-webhook] pago no aprobado, no se emite alerta");
    return res.status(200).json({
      ok: true,
      procesado: true,
      alertaEmitida: false,
      motivo: "pago no aprobado",
      status: statusPago,
    });
  }

  if (pagosYaAlertados.has(paymentId)) {
    console.log("[mp-webhook] duplicado: ya se alertó payment id=", paymentId);
    return res.status(200).json({
      ok: true,
      duplicate: true,
      paymentId,
    });
  }

  const parcial = mapearPagoAAlerta(pago, paymentId);
  if (parcial.monto == null || !Number.isFinite(parcial.monto)) {
    console.error("[mp-webhook] monto inválido en respuesta MP");
    return res.status(502).json({ ok: false, error: "Monto inválido en pago" });
  }

  const alerta = {
    id: nuevoId(),
    monto: parcial.monto,
    mensaje: parcial.mensaje,
    fecha: parcial.fecha,
    origen: parcial.origen,
    titular: parcial.titular,
  };

  pagosYaAlertados.add(paymentId);
  emitirAlerta(alerta, "mp-webhook payment " + paymentId);

  return res.status(200).json({
    ok: true,
    recibido: true,
    paymentId,
    alertaEmitida: true,
  });
}

module.exports = {
  handleMercadoPagoWebhook,
  /** Para tests / inspección */
  _internal: {
    obtenerTipoNotificacion,
    obtenerPaymentId,
    parseXSignature,
    construirManifest,
    validarFirmaWebhook,
  },
};
