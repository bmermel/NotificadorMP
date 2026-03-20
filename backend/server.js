const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { handleMercadoPagoWebhook } = require("./mercadopagoWebhook");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function nuevoId() {
  return crypto.randomUUID();
}

function parseMonto(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim().replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function strOEmpty(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

/**
 * Valida y normaliza el body hacia el contrato de alerta (endpoint de prueba manual).
 * No inventa monto: si falta o es inválido → error (no emite).
 */
function normalizarAlerta(body, origen) {
  if (body === null || body === undefined || typeof body !== "object") {
    return {
      ok: false,
      status: 400,
      error: "Body JSON inválido o vacío",
    };
  }

  const monto = parseMonto(body.monto);
  if (monto === null) {
    return {
      ok: false,
      status: 400,
      error:
        "monto es requerido y debe ser un número finito (o string numérico válido)",
    };
  }

  const mensaje = strOEmpty(body.mensaje);
  const titular = strOEmpty(body.titular);

  const alerta = {
    id: nuevoId(),
    monto,
    mensaje,
    fecha: new Date().toISOString(),
    origen: String(origen || "desconocido"),
    titular,
  };

  return { ok: true, alerta };
}

function emitirAlerta(alerta, contextoLog) {
  console.log(
    "[alertas] emit nueva-transferencia",
    contextoLog || "",
    JSON.stringify(alerta)
  );
  io.emit("nueva-transferencia", alerta);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mp-alertas-recepcion" });
});

/**
 * Webhook real Mercado Pago (notificaciones payment + API de pagos).
 * Simulación local: ver README o .env.example. Pruebas manuales: POST /api/alerta-prueba
 */
app.post("/webhooks/mercadopago", async (req, res) => {
  try {
    await handleMercadoPagoWebhook(req, res, { emitirAlerta, nuevoId });
  } catch (e) {
    console.error("[webhook] excepción no manejada:", e);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Error interno" });
    }
  }
});

app.post("/api/alerta-prueba", (req, res) => {
  console.log("[api] POST /api/alerta-prueba body:", req.body);

  try {
    const result = normalizarAlerta(req.body, "api.prueba");
    if (!result.ok) {
      console.warn("[api] alerta-prueba rechazada:", result.error);
      return res.status(result.status).json({ ok: false, error: result.error });
    }
    emitirAlerta(result.alerta, "prueba");
    return res.status(200).json({ ok: true, alerta: result.alerta });
  } catch (e) {
    console.error("[api] alerta-prueba excepción:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

io.on("connection", (socket) => {
  console.log("[socket] conectado id=", socket.id);
  socket.on("disconnect", (reason) => {
    console.log("[socket] desconectado id=", socket.id, "reason=", reason);
  });
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`[servidor] http://localhost:${PORT}`);
  console.log(`[servidor] GET  /health`);
  console.log(`[servidor] POST /webhooks/mercadopago (Mercado Pago real)`);
  console.log(
    `[servidor] POST /api/alerta-prueba (body: monto, mensaje?, titular?)`
  );
});
