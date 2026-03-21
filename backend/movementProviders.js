/**
 * Proveedores de movimientos de cuenta / actividades (intercambiables).
 *
 * La UI de Mercado Pago (/activities?operation=transfers, p2p_money_transfer, etc.)
 * no expone un REST público documentado equivalente. Las fuentes realistas son:
 * - payments_search: puente sobre el recurso Payment (no es "solo transferencia").
 * - settlement_report_stub: orientado al reporte "Account money" (CSV asíncrono; ver MP docs).
 * - activities_stub: documenta la limitación; no trae datos.
 */

const { mpGetJsonWithStatus } = require("./mpHttp");

function buildPaymentsSearchUrl(lookbackMs, limit) {
  const u = new URL("https://api.mercadopago.com/v1/payments/search");
  const now = Date.now();
  const fromIso = new Date(now - lookbackMs).toISOString();
  const toIso = new Date(now).toISOString();
  u.searchParams.set("sort", "date_created");
  u.searchParams.set("criteria", "desc");
  u.searchParams.set("range", "date_created");
  u.searchParams.set("begin_date", fromIso);
  u.searchParams.set("end_date", toIso);
  u.searchParams.set("limit", String(limit));
  return {
    url: u.toString(),
    params: {
      sort: "date_created",
      criteria: "desc",
      range: "date_created",
      begin_date: fromIso,
      end_date: toIso,
      limit: String(limit),
    },
  };
}

/**
 * @returns {{ name: string, requiresToken: boolean, fetchMovements: (ctx) => Promise<object> }}
 */
function createPaymentsSearchProvider() {
  return {
    name: "payments_search",
    requiresToken: true,
    description:
      "GET /v1/payments/search — lista pagos; una transferencia P2P puede no aparecer como payment o con otro payment_type_id.",
    fetchMovements: async function (ctx) {
      const built = buildPaymentsSearchUrl(ctx.lookbackMs, ctx.limit);
      const res = await mpGetJsonWithStatus(built.url, ctx.token);
      const results = Array.isArray(res.json.results) ? res.json.results : [];
      const movements = results.map(function (p) {
        return {
          dedupeId: String(p.id),
          source: "payments_search",
          rawPayment: p,
        };
      });
      return {
        ok: true,
        httpStatus: res.status,
        movements: movements,
        meta: {
          provider: "payments_search",
          searchParams: built.params,
          paging: res.json.paging || null,
          count: movements.length,
        },
      };
    },
  };
}

function createSettlementReportStubProvider() {
  return {
    name: "settlement_report_stub",
    requiresToken: false,
    description:
      "STUB — Reporte Account Money / settlement: requiere flujo asíncrono (crear reporte, listar, descargar CSV, parsear filas). Documentación: v1/account/settlement_report*",
    fetchMovements: async function () {
      console.log(
        "[movement-provider:settlement_report_stub] Sin implementación de descarga/parseo CSV. " +
          "Próximo paso: POST /v1/account/settlement_report → GET .../list → GET archivo → filtrar filas de ingreso / transferencias."
      );
      return {
        ok: true,
        httpStatus: null,
        movements: [],
        meta: {
          provider: "settlement_report_stub",
          stub: true,
          docsHint:
            "https://www.mercadopago.com.ar/developers/en/docs/checkout-api-payments/additional-content/reports/account-money/api",
        },
      };
    },
  };
}

function createActivitiesUiStubProvider() {
  return {
    name: "activities_ui_stub",
    requiresToken: false,
    description:
      "STUB — No hay API REST pública documentada equivalente a /activities?operation=transfers (p2p_money_transfer en la web).",
    fetchMovements: async function () {
      console.log(
        "[movement-provider:activities_ui_stub] La actividad 'transferencias' del sitio no se refleja 1:1 en un endpoint simple de esta integración."
      );
      return {
        ok: true,
        httpStatus: null,
        movements: [],
        meta: {
          provider: "activities_ui_stub",
          stub: true,
        },
      };
    },
  };
}

function getMovementProvider(providerName) {
  const n = String(providerName || "payments_search")
    .trim()
    .toLowerCase();
  if (n === "settlement_report" || n === "settlement_report_stub") {
    return createSettlementReportStubProvider();
  }
  if (n === "activities" || n === "activities_ui" || n === "activities_stub") {
    return createActivitiesUiStubProvider();
  }
  return createPaymentsSearchProvider();
}

module.exports = {
  getMovementProvider,
  buildPaymentsSearchUrl,
  createPaymentsSearchProvider,
  createSettlementReportStubProvider,
  createActivitiesUiStubProvider,
};
