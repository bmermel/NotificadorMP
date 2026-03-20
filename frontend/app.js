(function () {
  const socket = io();

  const estadoConexion = document.getElementById("estadoConexion");
  const ultimaAlerta = document.getElementById("ultimaAlerta");
  const historial = document.getElementById("historial");
  const overlay = document.getElementById("overlay");
  const overlayMonto = document.getElementById("overlayMonto");
  const overlayTexto = document.getElementById("overlayTexto");
  const overlayTitular = document.getElementById("overlayTitular");
  const btnPrueba = document.getElementById("btnPrueba");
  const pruebaMonto = document.getElementById("pruebaMonto");
  const pruebaMensaje = document.getElementById("pruebaMensaje");
  const pruebaTitular = document.getElementById("pruebaTitular");

  const MAX_HISTORIAL = 50;
  const historialAlertas = [];
  const idsVistos = new Set();
  let overlayTimer = null;

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function labelTitular(t) {
    const x = typeof t === "string" ? t.trim() : "";
    return x ? x : "Titular no informado";
  }

  function etiquetaOrigenCorta(origen) {
    const o = String(origen || "");
    if (o === "webhook.mercadopago") return "MP";
    if (o === "api.prueba") return "Prueba";
    return o.length > 12 ? o.slice(0, 10) + "…" : o || "?";
  }

  function esAlertaValida(data) {
    if (!data || typeof data !== "object") return false;
    if (typeof data.id !== "string" || !data.id) return false;
    if (typeof data.monto !== "number" || !Number.isFinite(data.monto))
      return false;
    if (typeof data.mensaje !== "string") return false;
    if (typeof data.fecha !== "string") return false;
    if (typeof data.origen !== "string") return false;
    if (typeof data.titular !== "string") return false;
    return true;
  }

  function setEstado(texto, modo) {
    estadoConexion.textContent = texto;
    estadoConexion.classList.remove("online", "offline", "reconnecting");
    if (modo === "online") estadoConexion.classList.add("online");
    else if (modo === "reconnecting") estadoConexion.classList.add("reconnecting");
    else estadoConexion.classList.add("offline");
  }

  socket.on("connect", function () {
    console.log("[socket] conectado transport=", socket.io.engine.transport.name);
    setEstado("Conectado", "online");
  });

  socket.on("disconnect", function (reason) {
    console.warn("[socket] disconnect reason=", reason);
    setEstado("Desconectado", "offline");
  });

  socket.on("connect_error", function (err) {
    console.error("[socket] connect_error", err && err.message);
    setEstado("Error de conexión", "offline");
  });

  socket.io.on("reconnect_attempt", function (n) {
    console.log("[socket] reconnect_attempt n=", n);
    setEstado("Reconectando…", "reconnecting");
  });

  socket.io.on("reconnect", function (n) {
    console.log("[socket] reconnect ok tras intentos=", n);
    setEstado("Conectado", "online");
  });

  socket.io.on("reconnect_failed", function () {
    console.error("[socket] reconnect_failed");
    setEstado("Sin conexión", "offline");
  });

  socket.on("nueva-transferencia", function (data) {
    try {
      if (!esAlertaValida(data)) {
        console.warn("[ui] payload inválido, ignorado:", data);
        return;
      }
      if (idsVistos.has(data.id)) {
        console.warn("[ui] duplicado ignorado id=", data.id);
        return;
      }
      idsVistos.add(data.id);
      console.log("[ui] nueva alerta id=", data.id, "origen=", data.origen);
      mostrarAlerta(data);
    } catch (e) {
      console.error("[ui] error procesando alerta:", e);
    }
  });

  btnPrueba.addEventListener("click", function () {
    const raw = (pruebaMonto && pruebaMonto.value) || "";
    const monto = Number(String(raw).replace(",", "."));
    const body = {
      monto: monto,
      mensaje: (pruebaMensaje && pruebaMensaje.value) || "",
      titular: (pruebaTitular && pruebaTitular.value) || "",
    };
    console.log("[ui] POST /api/alerta-prueba", body);

    fetch("/api/alerta-prueba", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (j) {
          return { res: res, json: j };
        });
      })
      .then(function (_ref) {
        const res = _ref.res;
        const json = _ref.json;
        if (!res.ok) {
          console.error("[ui] alerta-prueba error HTTP", res.status, json);
          return;
        }
        console.log("[ui] alerta-prueba ok", json);
      })
      .catch(function (e) {
        console.error("[ui] fetch alerta-prueba:", e);
      });
  });

  function formatearPesos(valor) {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(valor);
  }

  function reproducirSonido() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dur = 0.12;
      const gap = 0.08;
      [0, 1].forEach(function (i) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = i === 0 ? 880 : 660;
        o.connect(g);
        g.connect(ctx.destination);
        const t0 = ctx.currentTime + i * (dur + gap);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
      });
      setTimeout(function () {
        ctx.close();
      }, 600);
    } catch (e) {
      console.warn("[audio] no disponible:", e);
    }
  }

  function obtenerVoces() {
    if (!("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices() || [];
  }

  function listarVocesEnConsola(voices) {
    console.log("[speech] Voces disponibles (" + voices.length + "):");
    voices.forEach(function (v, i) {
      console.log(
        '  [' +
          i +
          '] name="' +
          v.name +
          '" lang="' +
          v.lang +
          '" default=' +
          v.default
      );
    });
  }

  function normalizarLang(lang) {
    return String(lang || "")
      .toLowerCase()
      .replace(/_/g, "-");
  }

  function elegirMejorVoz(voices) {
    if (!voices.length) {
      return {
        voice: null,
        idiomaElegido: "es-AR (fallback)",
        criterio: "sin voces en el motor",
      };
    }

    var ar = voices.find(function (v) {
      var l = normalizarLang(v.lang);
      return l === "es-ar" || l.indexOf("es-ar") === 0;
    });
    if (ar) {
      return {
        voice: ar,
        idiomaElegido: ar.lang,
        criterio: "prioridad: es-AR",
      };
    }

    var latinCodes = [
      "es-419",
      "es-mx",
      "es-uy",
      "es-cl",
      "es-co",
      "es-pe",
      "es-ve",
      "es-ec",
      "es-us",
      "es-pr",
      "es-gt",
      "es-cr",
      "es-pa",
      "es-do",
      "es-bo",
      "es-py",
      "es-ni",
      "es-hn",
      "es-sv",
      "es-cu",
    ];
    var i;
    var code;
    for (i = 0; i < latinCodes.length; i++) {
      code = latinCodes[i];
      var found = voices.find(function (v) {
        var l = normalizarLang(v.lang);
        return l === code || l.indexOf(code + "-") === 0;
      });
      if (found) {
        return {
          voice: found,
          idiomaElegido: found.lang,
          criterio: "español latinoamericano (" + code + ")",
        };
      }
    }

    var noEspana = voices.find(function (v) {
      var l = normalizarLang(v.lang);
      return l.indexOf("es-") === 0 && l.indexOf("es-es") !== 0;
    });
    if (noEspana) {
      return {
        voice: noEspana,
        idiomaElegido: noEspana.lang,
        criterio: "español (no es-ES)",
      };
    }

    var cualquierEs = voices.find(function (v) {
      return normalizarLang(v.lang).indexOf("es") === 0;
    });
    if (cualquierEs) {
      return {
        voice: cualquierEs,
        idiomaElegido: cualquierEs.lang,
        criterio: "cualquier español disponible",
      };
    }

    return {
      voice: null,
      idiomaElegido: "es-AR",
      criterio: "sin voz en español; motor predeterminado",
    };
  }

  function construirTextoHabladoSoloMonto(montoNumerico) {
    var montoStr = new Intl.NumberFormat("es-AR", {
      maximumFractionDigits: 0,
      useGrouping: true,
    }).format(montoNumerico);
    return montoStr + " pesos";
  }

  function ejecutarSpeechSynthesis(texto, voice) {
    var u = new SpeechSynthesisUtterance(texto);
    u.rate = 1.2;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || "es-AR";
    } else {
      u.lang = "es-AR";
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function hablarMonto(montoNumerico) {
    if (!("speechSynthesis" in window)) return;
    hablarMontoConReintento(montoNumerico, 0);
  }

  function hablarMontoConReintento(montoNumerico, reintento) {
    var voices = obtenerVoces();
    if (voices.length === 0 && reintento < 8) {
      setTimeout(function () {
        hablarMontoConReintento(montoNumerico, reintento + 1);
      }, 100);
      return;
    }

    listarVocesEnConsola(voices);

    var seleccion = elegirMejorVoz(voices);
    var texto = construirTextoHabladoSoloMonto(montoNumerico);

    console.log(
      "[speech] Voz elegida:",
      seleccion.voice ? seleccion.voice.name : "(predeterminada del sistema)"
    );
    console.log("[speech] Idioma (voice.lang):", seleccion.idiomaElegido);
    console.log("[speech] Criterio:", seleccion.criterio);
    console.log("[speech] Texto hablado (solo monto):", texto);

    ejecutarSpeechSynthesis(texto, seleccion.voice);
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.addEventListener("voiceschanged", function () {
      var v = obtenerVoces();
      if (v.length) {
        console.log(
          "[speech] voiceschanged, voces cargadas (" + v.length + ")"
        );
        listarVocesEnConsola(v);
      }
    });
  }

  function mostrarAlerta(data) {
    const montoFormateado = formatearPesos(data.monto);
    const fechaStr = data.fecha
      ? new Date(data.fecha).toLocaleString("es-AR")
      : new Date().toLocaleString("es-AR");
    const titularLbl = labelTitular(data.titular);

    ultimaAlerta.classList.remove("vacia");
    ultimaAlerta.innerHTML =
      "<div class=\"ultima-inner\">" +
      "<div><strong>" +
      escapeHtml(montoFormateado) +
      "</strong></div>" +
      '<div class="ultima-titular">' +
      escapeHtml(titularLbl) +
      "</div>" +
      "<div>" +
      escapeHtml(data.mensaje || "") +
      "</div>" +
      '<div class="ultima-meta">' +
      '<span class="ultima-origen">' +
      escapeHtml(etiquetaOrigenCorta(data.origen)) +
      "</span> · " +
      escapeHtml(fechaStr) +
      "</div>" +
      "</div>";

    historialAlertas.unshift({
      id: data.id,
      monto: data.monto,
      mensaje: data.mensaje,
      fecha: data.fecha,
      origen: data.origen,
      titular: data.titular,
    });
    if (historialAlertas.length > MAX_HISTORIAL) {
      historialAlertas.length = MAX_HISTORIAL;
    }
    renderHistorial();

    mostrarOverlay(montoFormateado, data.mensaje || "", titularLbl);
    reproducirSonido();
    hablarMonto(data.monto);
  }

  function renderHistorial() {
    historial.innerHTML = "";
    historialAlertas.forEach(function (item) {
      const div = document.createElement("div");
      div.className = "historial-item";
      const t = labelTitular(item.titular);
      const orig = etiquetaOrigenCorta(item.origen);
      div.innerHTML =
        '<div class="historial-top">' +
        '<span class="historial-origen" title="' +
        escapeHtml(String(item.origen || "")) +
        '">' +
        escapeHtml(orig) +
        "</span>" +
        '<div class="monto">' +
        escapeHtml(formatearPesos(item.monto)) +
        "</div>" +
        "</div>" +
        '<div class="detalle titular-line">' +
        escapeHtml(t) +
        "</div>" +
        '<div class="detalle">' +
        escapeHtml(item.mensaje || "") +
        "</div>" +
        '<div class="detalle fecha">' +
        escapeHtml(
          new Date(item.fecha).toLocaleString("es-AR")
        ) +
        "</div>";
      historial.appendChild(div);
    });
  }

  function mostrarOverlay(monto, mensaje, titularDisplay) {
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayMonto.textContent = monto;
    overlayTexto.textContent = mensaje || "";
    if (overlayTitular) {
      overlayTitular.textContent = titularDisplay;
    }
    overlay.classList.remove("oculto");
    overlayTimer = setTimeout(function () {
      overlay.classList.add("oculto");
      overlayTimer = null;
    }, 5000);
  }
})();
