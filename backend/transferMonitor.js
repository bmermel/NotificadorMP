const fs = require("fs");
const path = require("path");
const https = require("https");

function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return String(v).toLowerCase() === "true" || v === "1";
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1000, Math.floor(n)) : fallback;
}

function envList(name, fallbackCsv) {
  const raw = (process.env[name] || fallbackCsv || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function readState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ids: [], lastScanAt: null };
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return { ids: [], lastScanAt: null };
    const obj = JSON.parse(raw);
    return {
      ids: Array.isArray(obj.ids) ? obj.ids.map(String) : [],
      lastScanAt: obj.lastScanAt || null,
    };
  } catch (e) {
    console.error("[transfer-monitor] no se pudo leer state file:", e.message);
    return { ids: [], lastScanAt: null };
  }
}

function writeState(filePath, state) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          ids: state.ids,
          lastScanAt: state.lastScanAt || null,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (e) {
    console.error("[transfer-monitor] no se pudo escribir state file:", e.message);
  }
}

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

async function mpGetJson(urlStr, token) {
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  let res;
  if (typeof fetch === "function") {
    res = await fetch(urlStr, { method: "GET", headers });
  } else {
    res = await httpsGetJson(urlStr, headers);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error("Mercado Pago API HTTP " + res.status);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function parseAmount(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim().replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildTitular(payer) {
  if (!payer || typeof payer !== "object") return "Titular no informado";
  const fn = String(payer.first_name || "").trim();
  const ln = String(payer.last_name || "").trim();
  const full = [fn, ln].filter(Boolean).join(" ").trim();
  if (full) return full;
  const email = String(payer.email || "").trim();
  if (email) return email;
  return "Titular no informado";
}

/** Email parcialmente enmascarado para logs (no exponer dirección completa). */
function maskEmail(email) {
  const s = String(email || "").trim();
  if (!s) return null;
  const at = s.indexOf("@");
  if (at <= 0) return s.slice(0, 2) + "***";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const show = local.slice(0, Math.min(2, local.length));
  return show + "***@" + domain;
}

/** Nombre resumido sin datos completos (solo iniciales / prefijos). */
function maskNombreParte(part) {
  const t = String(part || "").trim();
  if (!t) return null;
  if (t.length <= 1) return t + "***";
  return t.charAt(0) + "***";
}

function payerResumenParaLog(payer) {
  if (!payer || typeof payer !== "object") return { email: null, nombre: null };
  const email = maskEmail(payer.email);
  const fn = maskNombreParte(payer.first_name);
  const ln = maskNombreParte(payer.last_name);
  const nombre =
    fn && ln ? fn + " " + ln : fn || ln || null;
  return { email: email, nombre: nombre };
}

function logResumenMovimiento(debug, prefix, payment) {
  if (!debug || !payment || typeof payment !== "object") return;
  const pr = payerResumenParaLog(payment.payer);
  console.log(prefix, {
    id: payment.id,
    status: payment.status,
    payment_type_id: payment.payment_type_id,
    operation_type: payment.operation_type,
    transaction_amount: payment.transaction_amount,
    date_created: payment.date_created,
    payer_email: pr.email,
    payer_nombre: pr.nombre,
  });
}

function looksLikeIncomingTransfer(payment, allowedTypes) {
  if (!payment || typeof payment !== "object") {
    return { ok: false, reason: "objeto de pago inválido" };
  }
  const status = String(payment.status || "").toLowerCase();
  if (status !== "approved") {
    return {
      ok: false,
      reason: "status no es 'approved' (actual: '" + (payment.status || "") + "')",
    };
  }
  if (String(payment.operation_type || "").toLowerCase() === "money_out") {
    return {
      ok: false,
      reason: "operation_type es 'money_out' (egreso; no se trata como ingreso)",
    };
  }
  const type = String(payment.payment_type_id || "").toLowerCase();
  if (allowedTypes.length > 0 && !allowedTypes.includes(type)) {
    return {
      ok: false,
      reason:
        "payment_type_id '" +
        type +
        "' no está en MP_TRANSFER_ALLOWED_PAYMENT_TYPES [" +
        allowedTypes.join(",") +
        "]",
    };
  }
  const amount = parseAmount(payment.transaction_amount);
  if (amount == null || amount <= 0) {
    return {
      ok: false,
      reason: "transaction_amount inválido o <= 0",
    };
  }
  var acceptReason =
    "cumple: status=approved; operation_type≠money_out; monto>0";
  if (allowedTypes.length > 0) {
    acceptReason +=
      "; payment_type_id '" +
      type +
      "' permitido [" +
      allowedTypes.join(",") +
      "]";
  } else {
    acceptReason += "; sin filtro por payment_type_id (lista vacía)";
  }
  return { ok: true, acceptReason: acceptReason };
}

function normalizeTransferToAlert(payment) {
  const paymentId = String(payment.id);
  const amount = parseAmount(payment.transaction_amount);
  const approvedAt =
    payment.date_approved || payment.date_last_updated || payment.date_created;
  return {
    movementId: paymentId,
    alert: {
      id: "mp-transfer-" + paymentId,
      monto: amount,
      mensaje: "Transferencia recibida",
      fecha:
        typeof approvedAt === "string"
          ? approvedAt
          : new Date(approvedAt || Date.now()).toISOString(),
      origen: "monitor.transferencias",
      titular: buildTitular(payment.payer),
    },
  };
}

function buildPaymentsSearchUrl(opts) {
  const u = new URL("https://api.mercadopago.com/v1/payments/search");
  const now = Date.now();
  const fromIso = new Date(now - opts.lookbackMs).toISOString();
  u.searchParams.set("sort", "date_created");
  u.searchParams.set("criteria", "desc");
  u.searchParams.set("range", "date_created");
  u.searchParams.set("begin_date", fromIso);
  u.searchParams.set("end_date", new Date(now).toISOString());
  u.searchParams.set("limit", String(opts.limit));
  return u.toString();
}

function createTransferMonitor(config) {
  const token = process.env.MP_ACCESS_TOKEN ? String(process.env.MP_ACCESS_TOKEN).trim() : "";
  const enabled = envBool("MP_TRANSFER_MONITOR_ENABLED", false);
  const intervalMs = envInt("MP_TRANSFER_MONITOR_INTERVAL_MS", 30000);
  const lookbackMs = envInt("MP_TRANSFER_MONITOR_LOOKBACK_MS", 24 * 60 * 60 * 1000);
  const limit = envInt("MP_TRANSFER_MONITOR_LIMIT", 50);
  const allowedTypes = envList(
    "MP_TRANSFER_ALLOWED_PAYMENT_TYPES",
    "bank_transfer,account_money"
  );
  const maxProcessed = envInt("MP_TRANSFER_MONITOR_MAX_PROCESSED_IDS", 500);
  const stateFile =
    process.env.MP_TRANSFER_MONITOR_STATE_FILE ||
    path.join(__dirname, "data", "transfer-monitor-state.json");
  const debug = envBool("MP_TRANSFER_MONITOR_DEBUG", false);

  let timer = null;
  let running = false;
  const loaded = readState(stateFile);
  const processedIds = new Set(loaded.ids);

  function saveIds() {
    const ids = Array.from(processedIds).slice(-maxProcessed);
    writeState(stateFile, { ids, lastScanAt: new Date().toISOString() });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (!enabled) return;
      if (!token) {
        console.warn("[transfer-monitor] MP_ACCESS_TOKEN no configurado, monitor inactivo.");
        return;
      }

      const url = buildPaymentsSearchUrl({ lookbackMs, limit });
      console.log("[transfer-monitor] consultando:", url);
      const data = await mpGetJson(url, token);
      const results = Array.isArray(data.results) ? data.results : [];
      console.log("[transfer-monitor] pagos recibidos:", results.length);

      // Recorrer del más viejo al más nuevo para emitir alertas en orden cronológico.
      const asc = results.slice().reverse();
      let emitted = 0;
      for (let i = 0; i < asc.length; i++) {
        const p = asc[i];
        const id = p && p.id != null ? String(p.id) : null;
        if (!id) {
          if (debug) {
            console.warn(
              "[transfer-monitor][debug] movimiento sin id, se omite"
            );
          }
          continue;
        }

        if (debug) {
          logResumenMovimiento(
            debug,
            "[transfer-monitor][debug] movimiento",
            p
          );
        }

        if (processedIds.has(id)) {
          if (debug) {
            console.log(
              "[transfer-monitor][debug] id=" +
                id +
                " DESCARTADO: ya procesado (deduplicación)"
            );
          }
          continue;
        }

        const transferCheck = looksLikeIncomingTransfer(p, allowedTypes);
        if (!transferCheck.ok) {
          if (debug) {
            console.log(
              "[transfer-monitor][debug] id=" +
                id +
                " DESCARTADO: " +
                transferCheck.reason
            );
          } else {
            console.log(
              "[transfer-monitor] skip payment",
              id,
              "-",
              transferCheck.reason
            );
          }
          processedIds.add(id);
          continue;
        }

        const mapped = normalizeTransferToAlert(p);
        if (!mapped.alert || mapped.alert.monto == null) {
          if (debug) {
            console.warn(
              "[transfer-monitor][debug] id=" +
                id +
                " DESCARTADO: normalización sin monto válido"
            );
          } else {
            console.warn("[transfer-monitor] skip payment sin datos válidos:", id);
          }
          processedIds.add(id);
          continue;
        }

        if (debug) {
          console.log(
            "[transfer-monitor][debug] id=" +
              id +
              " ACEPTADO como transferencia: " +
              (transferCheck.acceptReason || "criterios cumplidos")
          );
        }

        config.emitirAlerta(mapped.alert, "transfer-monitor payment " + id);
        processedIds.add(id);
        emitted += 1;
      }

      // Limitar tamaño en memoria y disco.
      if (processedIds.size > maxProcessed) {
        const tail = Array.from(processedIds).slice(-maxProcessed);
        processedIds.clear();
        tail.forEach((id) => processedIds.add(id));
      }
      saveIds();
      console.log("[transfer-monitor] ciclo completo. nuevas alertas:", emitted);
    } catch (e) {
      console.error("[transfer-monitor] error en polling:", e.message, e.body || "");
    } finally {
      running = false;
    }
  }

  return {
    start: function start() {
      if (!enabled) {
        console.log("[transfer-monitor] deshabilitado (MP_TRANSFER_MONITOR_ENABLED=false)");
        return;
      }
      console.log("[transfer-monitor] habilitado. intervalo(ms)=", intervalMs);
      console.log("[transfer-monitor] allowed payment_type_id =", allowedTypes.join(","));
      console.log("[transfer-monitor] state file =", stateFile);
      console.log("[transfer-monitor] debug detallado =", debug);
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop: function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      saveIds();
    },
  };
}

module.exports = {
  createTransferMonitor,
};
