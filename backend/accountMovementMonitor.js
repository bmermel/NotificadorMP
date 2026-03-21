/**
 * Monitor de movimientos de cuenta orientado a transferencias recibidas.
 * Usa un proveedor de datos intercambiable (ver movementProviders.js).
 * No asume payment === transferencia; el filtro exige señales coherentes de ingreso.
 */

const fs = require("fs");
const path = require("path");
const { getMovementProvider } = require("./movementProviders");

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

function envBoolDual(primary, fallback, defaultVal) {
  if (process.env[primary] !== undefined && process.env[primary] !== "") {
    return envBool(primary, defaultVal);
  }
  if (process.env[fallback] !== undefined && process.env[fallback] !== "") {
    return envBool(fallback, defaultVal);
  }
  return defaultVal;
}

function envIntDual(primary, fallback, defaultVal) {
  if (process.env[primary] !== undefined && process.env[primary] !== "") {
    return envInt(primary, defaultVal);
  }
  if (process.env[fallback] !== undefined && process.env[fallback] !== "") {
    return envInt(fallback, defaultVal);
  }
  return defaultVal;
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
    console.error("[account-movement] no se pudo leer state file:", e.message);
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
        { ids: state.ids, lastScanAt: state.lastScanAt || null },
        null,
        2
      ),
      "utf8"
    );
  } catch (e) {
    console.error("[account-movement] no se pudo escribir state file:", e.message);
  }
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
  console.log("[account-movement][debug] resumen", {
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
    payer_first_name: maskNombreParte(payment.payer && payment.payer.first_name),
    payer_last_name: maskNombreParte(payment.payer && payment.payer.last_name),
    collector_id: payment.collector_id,
    live_mode: payment.live_mode,
    currency_id: payment.currency_id,
    payment_method_id: payment.payment_method_id,
  });
  if (logRaw) {
    console.log(
      "[account-movement][debug] raw(truncado)=",
      truncateRawPayment(payment, 4000)
    );
  }
}

/**
 * Criterio de ingreso tipo transferencia.
 * Ref. MP: operation_type puede ser "money_transfer" (transferencia entre usuarios), distinto de regular_payment.
 * https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-api-payments/search-payments/get
 */
function looksLikeIncomingTransfer(
  payment,
  allowedTypes,
  windowBeginMs,
  acceptOperationTypes
) {
  const opTypes = Array.isArray(acceptOperationTypes)
    ? acceptOperationTypes
    : ["money_transfer"];

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
  const opType = String(payment.operation_type || "").toLowerCase();
  if (opType === "money_out") {
    return {
      ok: false,
      reason: "operation_type es 'money_out' (egreso)",
      reasonCode: "operation_money_out",
    };
  }
  const type = String(payment.payment_type_id || "").toLowerCase();
  const matchedByOperation =
    opTypes.length > 0 && opTypes.indexOf(opType) !== -1;

  if (!matchedByOperation) {
    if (allowedTypes.length > 0 && allowedTypes.indexOf(type) === -1) {
      return {
        ok: false,
        reason:
          "ni operation_type en [" +
          opTypes.join(",") +
          "] (actual: '" +
          (payment.operation_type || "") +
          "') ni payment_type_id '" +
          type +
          "' en [" +
          allowedTypes.join(",") +
          "]",
        reasonCode: "payment_type_not_allowed",
      };
    }
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
    "cumple: status=approved; operation_type≠money_out; monto>0; ventana de fechas";
  if (matchedByOperation) {
    acceptReason +=
      "; operation_type='" +
      opType +
      "' reconocido como transferencia (lista " +
      opTypes.join(",") +
      ")";
  } else if (allowedTypes.length > 0) {
    acceptReason +=
      "; payment_type_id '" + type + "' ∈ [" + allowedTypes.join(",") + "]";
  } else {
    acceptReason += "; sin filtro estricto de payment_type_id";
  }
  return { ok: true, acceptReason: acceptReason, reasonCode: "accepted" };
}

function normalizePaymentToAlert(payment) {
  const paymentId = String(payment.id);
  const amount = parseAmount(payment.transaction_amount);
  const approvedAt =
    payment.date_approved || payment.date_last_updated || payment.date_created;
  return {
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

function createAccountMovementMonitor(config) {
  const token = process.env.MP_ACCESS_TOKEN
    ? String(process.env.MP_ACCESS_TOKEN).trim()
    : "";

  const enabled = envBoolDual(
    "MP_ACCOUNT_MOVEMENT_MONITOR_ENABLED",
    "MP_TRANSFER_MONITOR_ENABLED",
    false
  );

  const intervalMs = envIntDual(
    "MP_ACCOUNT_MOVEMENT_INTERVAL_MS",
    "MP_TRANSFER_MONITOR_INTERVAL_MS",
    30000
  );

  const lookbackMs = envIntDual(
    "MP_ACCOUNT_MOVEMENT_LOOKBACK_MS",
    "MP_TRANSFER_MONITOR_LOOKBACK_MS",
    24 * 60 * 60 * 1000
  );

  const limit = envIntDual(
    "MP_ACCOUNT_MOVEMENT_LIMIT",
    "MP_TRANSFER_MONITOR_LIMIT",
    50
  );

  const allowedTypes = envList(
    "MP_ACCOUNT_MOVEMENT_ALLOWED_PAYMENT_TYPES",
    ""
  );
  const allowedTypesFallback = envList(
    "MP_TRANSFER_ALLOWED_PAYMENT_TYPES",
    "bank_transfer,account_money"
  );
  const effectiveAllowedTypes =
    allowedTypes.length > 0 ? allowedTypes : allowedTypesFallback;

  const acceptOperationTypesPrimary = envList(
    "MP_ACCOUNT_MOVEMENT_ACCEPT_OPERATION_TYPES",
    ""
  );
  const acceptOperationTypesFallback = envList(
    "MP_TRANSFER_ACCEPT_OPERATION_TYPES",
    "money_transfer"
  );
  const effectiveAcceptOperationTypes =
    acceptOperationTypesPrimary.length > 0
      ? acceptOperationTypesPrimary
      : acceptOperationTypesFallback;

  const maxProcessed = envIntDual(
    "MP_ACCOUNT_MOVEMENT_MAX_PROCESSED_IDS",
    "MP_TRANSFER_MONITOR_MAX_PROCESSED_IDS",
    500
  );

  const stateFile =
    (process.env.MP_ACCOUNT_MOVEMENT_STATE_FILE || "").trim() ||
    (process.env.MP_TRANSFER_MONITOR_STATE_FILE || "").trim() ||
    path.join(__dirname, "data", "transfer-monitor-state.json");

  const debug = envBoolDual(
    "MP_ACCOUNT_MOVEMENT_DEBUG",
    "MP_TRANSFER_MONITOR_DEBUG",
    false
  );

  const logRaw = envBoolDual(
    "MP_ACCOUNT_MOVEMENT_LOG_RAW",
    "MP_TRANSFER_MONITOR_LOG_RAW",
    false
  );

  const providerName =
    (process.env.MP_ACCOUNT_MOVEMENT_PROVIDER || "payments_search").trim();

  const provider = getMovementProvider(providerName);

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
    lastProviderMeta: null,
    lastCycleLabel: null,
  };

  function saveIds() {
    const ids = Array.from(processedIds).slice(-maxProcessed);
    writeState(stateFile, { ids: ids, lastScanAt: new Date().toISOString() });
  }

  function bumpReject(map, code) {
    map[code] = (map[code] || 0) + 1;
  }

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
      "[account-movement] ========== CICLO INICIO [" +
        label +
        "] " +
        t0 +
        " =========="
    );
    console.log(
      "[account-movement] proveedor=" +
        provider.name +
        " — " +
        provider.description
    );

    if (!enabled) {
      console.log("[account-movement] omitido: monitor deshabilitado (env)");
      audit.lastErrorMessage = "monitor deshabilitado por configuración";
      return {
        ok: false,
        skipped: true,
        reason: "monitor_disabled",
        provider: provider.name,
        rejectReasons: {},
        acceptedIds: [],
        rejectedIds: [],
        fetched: 0,
        accepted: 0,
        rejected: 0,
      };
    }

    if (provider.requiresToken && !token) {
      const msg = "MP_ACCESS_TOKEN no configurado (requerido para este proveedor)";
      console.warn("[account-movement]", msg);
      audit.lastErrorAt = new Date().toISOString();
      audit.lastErrorMessage = msg;
      return {
        ok: false,
        error: msg,
        provider: provider.name,
        rejectReasons: {},
        acceptedIds: [],
        rejectedIds: [],
        fetched: 0,
        accepted: 0,
        rejected: 0,
      };
    }

    let fetchOut;
    try {
      fetchOut = await provider.fetchMovements({
        token: token,
        lookbackMs: lookbackMs,
        limit: limit,
      });
    } catch (e) {
      audit.lastErrorAt = new Date().toISOString();
      audit.lastErrorMessage = e.message || String(e);
      audit.lastHttpStatus = e.status != null ? e.status : audit.lastHttpStatus;
      console.error(
        "[account-movement] error al obtener movimientos:",
        e.message,
        e.body ? JSON.stringify(e.body).slice(0, 800) : ""
      );
      throw e;
    }

    audit.lastHttpStatus = fetchOut.httpStatus != null ? fetchOut.httpStatus : null;
    audit.lastProviderMeta = fetchOut.meta || null;
    audit.lastSearchParams =
      fetchOut.meta && fetchOut.meta.searchParams
        ? fetchOut.meta.searchParams
        : null;
    audit.lastPaging =
      fetchOut.meta && fetchOut.meta.paging != null
        ? fetchOut.meta.paging
        : audit.lastPaging;

    if (fetchOut.httpStatus != null) {
      console.log(
        "[account-movement] HTTP proveedor:",
        fetchOut.httpStatus,
        "(null si stub sin llamada HTTP)"
      );
    }

    const movements = Array.isArray(fetchOut.movements) ? fetchOut.movements : [];
    audit.lastFetchedCount = movements.length;

    if (movements.length === 0) {
      console.warn(
        "[account-movement] 0 movimientos del proveedor. ¿stub, ventana vacía, o la fuente no incluye transferencias P2P?"
      );
    } else {
      console.log(
        "[account-movement] movimientos recibidos del proveedor:",
        movements.length
      );
    }

    if (fetchOut.meta && fetchOut.meta.stub) {
      console.log(
        "[account-movement] meta proveedor:",
        JSON.stringify(fetchOut.meta)
      );
    }

    const asc = movements.slice().reverse();
    for (let i = 0; i < asc.length; i++) {
      const mov = asc[i];
      const dedupeId = mov && mov.dedupeId != null ? String(mov.dedupeId) : null;
      if (!dedupeId) {
        if (debug) {
          console.warn("[account-movement][debug] ítem sin dedupeId");
        }
        bumpReject(rejectReasons, "missing_id");
        continue;
      }

      const p = mov.rawPayment;
      if (!p || typeof p !== "object") {
        if (debug) {
          console.log(
            "[account-movement][debug] dedupeId=" +
              dedupeId +
              " DESCARTADO [provider_no_payment_shape]: el proveedor no expuso rawPayment (integrar parseo de reporte CSV u otro formato)"
          );
        }
        bumpReject(rejectReasons, "provider_no_payment_shape");
        continue;
      }

      if (debug) {
        logMovimientoDebug(debug, logRaw, p);
      }

      if (processedIds.has(dedupeId)) {
        if (debug) {
          console.log(
            "[account-movement][debug] id=" +
              dedupeId +
              " DESCARTADO [duplicate]"
          );
        } else {
          console.log("[account-movement] skip id=" + dedupeId + " duplicate");
        }
        rejectedIds.push(dedupeId);
        bumpReject(rejectReasons, "duplicate");
        continue;
      }

      const transferCheck = looksLikeIncomingTransfer(
        p,
        effectiveAllowedTypes,
        windowBeginMs,
        effectiveAcceptOperationTypes
      );
      if (!transferCheck.ok) {
        const code = transferCheck.reasonCode || "rejected";
        if (debug) {
          console.log(
            "[account-movement][debug] id=" +
              dedupeId +
              " DESCARTADO [" +
              code +
              "]: " +
              transferCheck.reason
          );
        } else {
          console.log(
            "[account-movement] skip id=" + dedupeId + " - " + transferCheck.reason
          );
        }
        processedIds.add(dedupeId);
        rejectedIds.push(dedupeId);
        bumpReject(rejectReasons, code);
        continue;
      }

      const mapped = normalizePaymentToAlert(p);
      if (!mapped.alert || mapped.alert.monto == null) {
        const code = "normalize_failed";
        if (debug) {
          console.warn(
            "[account-movement][debug] id=" + dedupeId + " DESCARTADO [" + code + "]"
          );
        } else {
          console.warn("[account-movement] skip id=" + dedupeId + " " + code);
        }
        processedIds.add(dedupeId);
        rejectedIds.push(dedupeId);
        bumpReject(rejectReasons, code);
        continue;
      }

      if (debug) {
        console.log(
          "[account-movement][debug] id=" +
            dedupeId +
            " ACEPTADO: " +
            (transferCheck.acceptReason || "")
        );
      }

      if (emitAlerts) {
        config.emitirAlerta(
          mapped.alert,
          "account-movement " + provider.name + " " + dedupeId
        );
      }
      processedIds.add(dedupeId);
      acceptedIds.push(dedupeId);
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
      "[account-movement] ========== CICLO FIN [" +
        label +
        "] nuevas alertas=" +
        emitted +
        " rechazados=" +
        rejectedIds.length +
        " =========="
    );

    return {
      ok: true,
      provider: provider.name,
      httpStatus: fetchOut.httpStatus,
      fetched: movements.length,
      accepted: emitted,
      rejected: rejectedIds.length,
      rejectReasons: rejectReasons,
      acceptedIds: acceptedIds,
      rejectedIds: rejectedIds,
      paging: fetchOut.meta ? fetchOut.meta.paging : null,
    };
  }

  async function tick() {
    if (running) {
      console.warn("[account-movement] ciclo omitido: ejecución en curso");
      return;
    }
    running = true;
    try {
      await runCycle({ label: "interval", emitAlerts: true });
    } catch (e) {
      /* logueado en runCycle */
    } finally {
      running = false;
    }
  }

  async function runOnce() {
    if (running) {
      return {
        ok: false,
        busy: true,
        message: "Otro ciclo está en ejecución",
      };
    }
    running = true;
    try {
      return await runCycle({ label: "manual-run-once", emitAlerts: true });
    } catch (e) {
      return {
        ok: false,
        error: e.message || String(e),
        httpStatus: e.status,
        provider: provider.name,
      };
    } finally {
      running = false;
    }
  }

  function getSnapshot() {
    return {
      ok: true,
      monitor: "account_movement",
      started: started,
      enabled: enabled,
      provider: provider.name,
      providerDescription: provider.description,
      intervalMs: intervalMs,
      lookbackMs: lookbackMs,
      limit: limit,
      allowedPaymentTypes: effectiveAllowedTypes.slice(),
      acceptOperationTypes: effectiveAcceptOperationTypes.slice(),
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
      lastProviderMeta: audit.lastProviderMeta,
      lastCycleLabel: audit.lastCycleLabel,
      stateFile: stateFile,
      cycleRunning: running,
    };
  }

  return {
    start: function start() {
      started = true;
      if (!enabled) {
        console.log(
          "[account-movement] deshabilitado (MP_ACCOUNT_MOVEMENT_MONITOR_ENABLED / MP_TRANSFER_MONITOR_ENABLED)"
        );
        return;
      }
      console.log("[account-movement] ARRANQUE servidor → monitor programado");
      console.log("[account-movement] intervalo(ms)=", intervalMs);
      console.log("[account-movement] proveedor=", provider.name);
      console.log("[account-movement] state file=", stateFile);
      console.log("[account-movement] debug=", debug, "logRaw=", logRaw);
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

function createTransferMonitor(config) {
  return createAccountMovementMonitor(config);
}

module.exports = {
  createAccountMovementMonitor,
  createTransferMonitor,
};
