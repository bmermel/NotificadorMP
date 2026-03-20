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

/**
 * GET Mercado Pago JSON con código HTTP visible para auditoría.
 */
async function mpGetJsonWithStatus(urlStr, token) {
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
  const status = res.status;
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { parseError: true, rawPreview: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error("Mercado Pago API HTTP " + status);
    err.status = status;
    err.body = json;
    throw err;
  }
  return { status: status, json: json };
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

function maskNombreParte(part) {
  const t = String(part || "").trim();
  if (!t) return null;
  if (t.length <= 1) return t + "***";
  return t.charAt(0) + "***";
}

function payerResumenParaLog(payer) {
  if (!payer || typeof payer !== "object") return { email: null, nombre: null };
  return {
    email: maskEmail(payer.email),
    nombre:
      maskNombreParte(payer.first_name) && maskNombreParte(payer.last_name)
        ? maskNombreParte(payer.first_name) + " " + maskNombreParte(payer.last_name)
        : maskNombreParte(payer.first_name) || maskNombreParte(payer.last_name),
  };
}

/** JSON truncado; enmascara emails en strings para LOG_RAW más seguro. */
function truncateRawPayment(payment, maxLen) {
  let s = JSON.stringify(payment);
  s = s.replace(
    /"email"\s*:\s*"([^"\\]*)"/gi,
    function (_m, em) {
      return '"email":"' + (maskEmail(em) || "***") + '"';
    }
  );
  if (s.length > maxLen) {
    return s.slice(0, maxLen) + "...[truncado " + s.length + " chars]";
  }
  return s;
}

function logMovimientoDebug(debug, logRaw, payment) {
  if (!debug || !payment || typeof payment !== "object") return;
  const pr = payerResumenParaLog(payment.payer);
  const row = {
    id: payment.id,
    status: payment.status,
    status_detail: payment.status_detail,
    payment_type_id: payment.payment_type_id,
    operation_type: payment.operation_type,
    transaction_amount: payment.transaction_amount,
    transaction_amount_refunded: payment.transaction_amount_refunded,
    date_created: payment.date_created,
    date_approved: payment.date_approved,
    money_release_date: payment.money_release_date,
    description: payment.description,
    external_reference: payment.external_reference,
    payer_email: pr.email,
    payer_first_name: maskNombreParte(
      payment.payer && payment.payer.first_name
    ),
    payer_last_name: maskNombreParte(
      payment.payer && payment.payer.last_name
    ),
    collector_id: payment.collector_id,
    live_mode: payment.live_mode,
    currency_id: payment.currency_id,
    payment_method_id: payment.payment_method_id,
  };
  console.log("[transfer-monitor][debug] resumen movimiento", row);
  if (logRaw) {
    console.log(
      "[transfer-monitor][debug] raw(truncado)=",
      truncateRawPayment(payment, 4000)
    );
  }
}

/**
 * Evalúa si el pago parece una transferencia entrante acreditada.
 * reasonCode sirve para agrupar en informes.
 */
function looksLikeIncomingTransfer(payment, allowedTypes, windowBeginMs) {
  if (!payment || typeof payment !== "object") {
    return {
      ok: false,
      reason: "objeto de pago inválido",
      reasonCode: "invalid_object",
    };
  }
  if (payment.date_created) {
    const dc = new Date(payment.date_created).getTime();
    if (!isNaN(dc) && dc < windowBeginMs) {
      return {
        ok: false,
        reason:
          "date_created anterior a la ventana begin_date del search (posible inconsistencia o caché)",
        reasonCode: "date_before_window",
      };
    }
  }
  const status = String(payment.status || "").toLowerCase();
  if (status !== "approved") {
    return {
      ok: false,
      reason: "status no es 'approved' (actual: '" + (payment.status || "") + "')",
      reasonCode: "not_approved",
    };
  }
  if (String(payment.operation_type || "").toLowerCase() === "money_out") {
    return {
      ok: false,
      reason: "operation_type es 'money_out' (egreso)",
      reasonCode: "operation_money_out",
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
      reasonCode: "payment_type_not_allowed",
    };
  }
  const amount = parseAmount(payment.transaction_amount);
  if (amount == null || amount <= 0) {
    return {
      ok: false,
      reason: "transaction_amount inválido o <= 0",
      reasonCode: "invalid_amount",
    };
  }
  var acceptReason =
    "cumple: status=approved; operation_type≠money_out; monto>0; fecha dentro de ventana o sin date_created";
  if (allowedTypes.length > 0) {
    acceptReason +=
      "; payment_type_id '" +
      type +
      "' ∈ [" +
      allowedTypes.join(",") +
      "]";
  } else {
    acceptReason += "; lista MP_TRANSFER_ALLOWED_PAYMENT_TYPES vacía (no filtra tipo)";
  }
  return { ok: true, acceptReason: acceptReason, reasonCode: "accepted" };
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
  const toIso = new Date(now).toISOString();
  u.searchParams.set("sort", "date_created");
  u.searchParams.set("criteria", "desc");
  u.searchParams.set("range", "date_created");
  u.searchParams.set("begin_date", fromIso);
  u.searchParams.set("end_date", toIso);
  u.searchParams.set("limit", String(opts.limit));
  return { url: u.toString(), beginIso: fromIso, endIso: toIso };
}

function createTransferMonitor(config) {
  const token = process.env.MP_ACCESS_TOKEN
    ? String(process.env.MP_ACCESS_TOKEN).trim()
    : "";
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
  const logRaw = envBool("MP_TRANSFER_MONITOR_LOG_RAW", false);

  let timer = null;
  let running = false;
  let started = false;
  const loaded = readState(stateFile);
  const processedIds = new Set(loaded.ids);

  const audit = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastHttpStatus: null,
    lastFetchedCount: 0,
    lastAcceptedCount: 0,
    lastRejectedCount: 0,
    lastPaging: null,
    lastSearchParams: null,
    lastCycleLabel: null,
  };

  function saveIds() {
    const ids = Array.from(processedIds).slice(-maxProcessed);
    writeState(stateFile, { ids, lastScanAt: new Date().toISOString() });
  }

  function bumpReject(map, code) {
    map[code] = (map[code] || 0) + 1;
  }

  /**
   * Un ciclo completo: consulta MP, evalúa ítems, emite alertas.
   * @param {{ label: string, emitAlerts?: boolean }} opts
   */
  async function runCycle(opts) {
    const label = opts.label || "cycle";
    const emitAlerts = opts.emitAlerts !== false;
    const windowBeginMs = Date.now() - lookbackMs;

    const rejectReasons = {};
    const acceptedIds = [];
    const rejectedIds = [];
    let emitted = 0;

    const t0 = new Date().toISOString();
    audit.lastRunAt = t0;
    audit.lastCycleLabel = label;

    console.log(
      "[transfer-monitor] ========== CICLO INICIO [" + label + "] " + t0 + " =========="
    );

    if (!enabled) {
      console.log("[transfer-monitor] omitido: MP_TRANSFER_MONITOR_ENABLED=false");
      audit.lastErrorMessage = "monitor deshabilitado por configuración";
      return {
        ok: false,
        skipped: true,
        reason: "monitor_disabled",
        rejectReasons: {},
        acceptedIds: [],
        rejectedIds: [],
        fetched: 0,
        accepted: 0,
        rejected: 0,
      };
    }

    if (!token) {
      const msg = "MP_ACCESS_TOKEN no configurado";
      console.warn("[transfer-monitor]", msg);
      audit.lastErrorAt = new Date().toISOString();
      audit.lastErrorMessage = msg;
      return {
        ok: false,
        error: msg,
        rejectReasons: {},
        acceptedIds: [],
        rejectedIds: [],
        fetched: 0,
        accepted: 0,
        rejected: 0,
      };
    }

    const built = buildPaymentsSearchUrl({ lookbackMs, limit });
    const url = built.url;
    const uObj = new URL(url);
    const paramsFlat = {
      sort: uObj.searchParams.get("sort"),
      criteria: uObj.searchParams.get("criteria"),
      range: uObj.searchParams.get("range"),
      begin_date: uObj.searchParams.get("begin_date"),
      end_date: uObj.searchParams.get("end_date"),
      limit: uObj.searchParams.get("limit"),
    };
    audit.lastSearchParams = paramsFlat;

    console.log("[transfer-monitor] consulta API: GET /v1/payments/search");
    console.log("[transfer-monitor] parámetros:", JSON.stringify(paramsFlat));
    console.log("[transfer-monitor] lookbackMs=", lookbackMs, "intervalMs=", intervalMs);

    let httpStatus;
    let data;
    try {
      const res = await mpGetJsonWithStatus(url, token);
      httpStatus = res.status;
      data = res.json;
      audit.lastHttpStatus = httpStatus;
      console.log(
        "[transfer-monitor] respuesta HTTP",
        httpStatus,
        "(esperado 200 para cuerpo JSON)"
      );
    } catch (e) {
      audit.lastErrorAt = new Date().toISOString();
      audit.lastErrorMessage = e.message || String(e);
      audit.lastHttpStatus = e.status != null ? e.status : audit.lastHttpStatus;
      console.error(
        "[transfer-monitor] error HTTP/API:",
        e.message,
        e.body ? JSON.stringify(e.body).slice(0, 800) : ""
      );
      throw e;
    }

    const paging = data && data.paging ? data.paging : null;
    audit.lastPaging = paging;
    if (paging) {
      console.log("[transfer-monitor] paging:", JSON.stringify(paging));
    }

    const results = Array.isArray(data.results) ? data.results : [];
    audit.lastFetchedCount = results.length;

    if (results.length === 0) {
      console.warn(
        "[transfer-monitor] results vacío: no hay pagos en la ventana o el token no devolvió resultados."
      );
    } else {
      console.log("[transfer-monitor] resultados útiles: cantidad=", results.length);
    }

    const asc = results.slice().reverse();
    for (let i = 0; i < asc.length; i++) {
      const p = asc[i];
      const id = p && p.id != null ? String(p.id) : null;
      if (!id) {
        if (debug) {
          console.warn("[transfer-monitor][debug] ítem sin id, se omite");
        }
        bumpReject(rejectReasons, "missing_id");
        continue;
      }

      if (debug) {
        logMovimientoDebug(debug, logRaw, p);
      }

      if (processedIds.has(id)) {
        if (debug) {
          console.log(
            "[transfer-monitor][debug] id=" +
              id +
              " DESCARTADO [duplicate]: ya en cola procesada (deduplicación)"
          );
        } else {
          console.log("[transfer-monitor] skip id=" + id + " duplicate");
        }
        rejectedIds.push(id);
        bumpReject(rejectReasons, "duplicate");
        continue;
      }

      const transferCheck = looksLikeIncomingTransfer(
        p,
        allowedTypes,
        windowBeginMs
      );
      if (!transferCheck.ok) {
        const code = transferCheck.reasonCode || "rejected";
        if (debug) {
          console.log(
            "[transfer-monitor][debug] id=" +
              id +
              " DESCARTADO [" +
              code +
              "]: " +
              transferCheck.reason
          );
        } else {
          console.log(
            "[transfer-monitor] skip id=" + id + " - " + transferCheck.reason
          );
        }
        processedIds.add(id);
        rejectedIds.push(id);
        bumpReject(rejectReasons, code);
        continue;
      }

      const mapped = normalizeTransferToAlert(p);
      if (!mapped.alert || mapped.alert.monto == null) {
        const code = "normalize_failed";
        if (debug) {
          console.warn(
            "[transfer-monitor][debug] id=" +
              id +
              " DESCARTADO [" +
              code +
              "]: normalización sin monto"
          );
        } else {
          console.warn("[transfer-monitor] skip id=" + id + " normalize_failed");
        }
        processedIds.add(id);
        rejectedIds.push(id);
        bumpReject(rejectReasons, code);
        continue;
      }

      if (debug) {
        console.log(
          "[transfer-monitor][debug] id=" +
            id +
            " ACEPTADO [transferencia]: " +
            (transferCheck.acceptReason || "")
        );
      }

      if (emitAlerts) {
        config.emitirAlerta(mapped.alert, "transfer-monitor payment " + id);
      }
      processedIds.add(id);
      acceptedIds.push(id);
      emitted += 1;
    }

    if (processedIds.size > maxProcessed) {
      const tail = Array.from(processedIds).slice(-maxProcessed);
      processedIds.clear();
      tail.forEach(function (x) {
        processedIds.add(x);
      });
    }
    saveIds();

    audit.lastAcceptedCount = emitted;
    audit.lastRejectedCount = rejectedIds.length;
    audit.lastSuccessAt = new Date().toISOString();
    audit.lastErrorAt = null;
    audit.lastErrorMessage = null;

    console.log(
      "[transfer-monitor] ========== CICLO FIN [" +
        label +
        "] alertas nuevas=" +
        emitted +
        " rechazados=" +
        rejectedIds.length +
        " =========="
    );

    return {
      ok: true,
      httpStatus: httpStatus,
      fetched: results.length,
      accepted: emitted,
      rejected: rejectedIds.length,
      rejectReasons: rejectReasons,
      acceptedIds: acceptedIds,
      rejectedIds: rejectedIds,
      paging: paging,
    };
  }

  async function tick() {
    if (running) {
      console.warn("[transfer-monitor] ciclo omitido: ya hay una ejecución en curso");
      return;
    }
    running = true;
    try {
      await runCycle({ label: "interval", emitAlerts: true });
    } catch (e) {
      /* error ya logueado en runCycle */
    } finally {
      running = false;
    }
  }

  async function runOnce() {
    if (running) {
      return {
        ok: false,
        busy: true,
        message: "Otro ciclo del monitor está en ejecución",
      };
    }
    running = true;
    try {
      const out = await runCycle({ label: "manual-run-once", emitAlerts: true });
      return out;
    } catch (e) {
      return {
        ok: false,
        error: e.message || String(e),
        httpStatus: e.status,
      };
    } finally {
      running = false;
    }
  }

  function getSnapshot() {
    return {
      ok: true,
      started: started,
      enabled: enabled,
      intervalMs: intervalMs,
      lookbackMs: lookbackMs,
      limit: limit,
      allowedPaymentTypes: allowedTypes.slice(),
      processedIdsCount: processedIds.size,
      debug: debug,
      logRaw: logRaw,
      lastRunAt: audit.lastRunAt,
      lastSuccessAt: audit.lastSuccessAt,
      lastErrorAt: audit.lastErrorAt,
      lastErrorMessage: audit.lastErrorMessage,
      lastHttpStatus: audit.lastHttpStatus,
      lastFetchedCount: audit.lastFetchedCount,
      lastAcceptedCount: audit.lastAcceptedCount,
      lastRejectedCount: audit.lastRejectedCount,
      lastPaging: audit.lastPaging,
      lastSearchParams: audit.lastSearchParams,
      lastCycleLabel: audit.lastCycleLabel,
      stateFile: stateFile,
      cycleRunning: running,
    };
  }

  return {
    start: function start() {
      started = true;
      if (!enabled) {
        console.log("[transfer-monitor] deshabilitado (MP_TRANSFER_MONITOR_ENABLED=false)");
        return;
      }
      console.log("[transfer-monitor] ARRANQUE: monitor activo. intervalo(ms)=", intervalMs);
      console.log("[transfer-monitor] allowed payment_type_id =", allowedTypes.join(","));
      console.log("[transfer-monitor] state file =", stateFile);
      console.log("[transfer-monitor] MP_TRANSFER_MONITOR_DEBUG =", debug);
      console.log("[transfer-monitor] MP_TRANSFER_MONITOR_LOG_RAW =", logRaw);
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop: function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      saveIds();
    },
    getSnapshot: getSnapshot,
    runOnce: runOnce,
  };
}

module.exports = {
  createTransferMonitor,
};
