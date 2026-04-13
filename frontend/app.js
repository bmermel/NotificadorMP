(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Socket.io + referencias DOM
  // ---------------------------------------------------------------------------
  const socket = io();

  const estadoConexion  = document.getElementById('estadoConexion');
  const ultimaAlerta    = document.getElementById('ultimaAlerta');
  const historialEl     = document.getElementById('historial');
  const overlay         = document.getElementById('overlay');
  const overlayMonto    = document.getElementById('overlayMonto');
  const overlayTexto    = document.getElementById('overlayTexto');
  const overlayTitular  = document.getElementById('overlayTitular');
  const overlayClose    = document.getElementById('overlayClose');
  const btnPrueba       = document.getElementById('btnPrueba');
  const pruebaMonto     = document.getElementById('pruebaMonto');
  const pruebaMensaje   = document.getElementById('pruebaMensaje');
  const pruebaTitular   = document.getElementById('pruebaTitular');
  const btnToggleSonido = document.getElementById('btnToggleSonido');
  const btnToggleVoz    = document.getElementById('btnToggleVoz');
  const badgeNoVistos   = document.getElementById('badgeNoVistos');

  // ---------------------------------------------------------------------------
  // Estado global
  // ---------------------------------------------------------------------------
  const MAX_HISTORIAL = 100;

  /** @type {Array<{id, monto, moneda, mensaje, fecha, origen, titular, provider, visto}>} */
  let historialAlertas = [];
  const idsEnUI = new Set();  // deduplicación en UI

  let sonidoActivo = true;
  let vozActiva    = true;
  let overlayTimer = null;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function labelTitular(t) {
    const x = typeof t === 'string' ? t.trim() : '';
    return x ? x : 'Titular no informado';
  }

  function etiquetaOrigenCorta(origen) {
    const o = String(origen || '');
    if (o === 'webhook.mercadopago')   return 'MP-webhook';
    if (o === 'monitor.transferencias') return 'MP-monitor';
    if (o === 'api.prueba')            return 'Prueba';
    return o.length > 14 ? o.slice(0, 12) + '…' : o || '?';
  }

  function formatearPesos(valor) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(valor);
  }

  function esAlertaValida(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.id !== 'string' || !data.id) return false;
    if (typeof data.monto !== 'number' || !Number.isFinite(data.monto)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Estado de conexión
  // ---------------------------------------------------------------------------

  function setEstado(texto, modo) {
    estadoConexion.textContent = texto;
    estadoConexion.classList.remove('online', 'offline', 'reconnecting');
    estadoConexion.classList.add(modo === 'online' ? 'online'
      : modo === 'reconnecting' ? 'reconnecting' : 'offline');
  }

  // ---------------------------------------------------------------------------
  // Toggles sonido / voz
  // ---------------------------------------------------------------------------

  function actualizarToggle(btn, activo, labelOn, labelOff) {
    btn.textContent = activo ? labelOn : labelOff;
    btn.classList.toggle('activo', activo);
    btn.classList.toggle('inactivo', !activo);
  }

  btnToggleSonido.addEventListener('click', function () {
    sonidoActivo = !sonidoActivo;
    actualizarToggle(btnToggleSonido, sonidoActivo, '🔊 Sonido', '🔇 Sonido');
  });

  btnToggleVoz.addEventListener('click', function () {
    vozActiva = !vozActiva;
    actualizarToggle(btnToggleVoz, vozActiva, '🗣 Voz', '🔕 Voz');
  });

  // ---------------------------------------------------------------------------
  // Badge "no vistos"
  // ---------------------------------------------------------------------------

  function actualizarBadge() {
    const noVistos = historialAlertas.filter(function (a) { return !a.visto; }).length;
    if (noVistos > 0) {
      badgeNoVistos.textContent = noVistos;
      badgeNoVistos.style.display = 'inline-block';
    } else {
      badgeNoVistos.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------------------
  // Audio (Web Audio API)
  // ---------------------------------------------------------------------------

  function reproducirSonido() {
    if (!sonidoActivo) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dur = 0.12;
      const gap = 0.08;
      [0, 1].forEach(function (i) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
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
      setTimeout(function () { ctx.close(); }, 600);
    } catch (e) {
      console.warn('[audio] no disponible:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Síntesis de voz — ElevenLabs (principal) + browser TTS (fallback)
  // ---------------------------------------------------------------------------

  // Detecta si ElevenLabs está disponible al cargar la página
  var elevenLabsDisponible = false;
  fetch('/api/tts/status')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      elevenLabsDisponible = j.elevenlabs === true;
      console.log('[tts] ElevenLabs disponible:', elevenLabsDisponible);
    })
    .catch(function () {
      elevenLabsDisponible = false;
    });

  /**
   * Construye el texto que se va a leer en voz alta.
   * Podés cambiarlo a tu gusto.
   */
  function construirTextoVoz(montoNumerico) {
    var montoStr = new Intl.NumberFormat('es-AR', {
      maximumFractionDigits: 0, useGrouping: true,
    }).format(montoNumerico);
    return '¡Cayeron ' + montoStr + ' pesos!';
  }

  /** Llama al backend que hace proxy a ElevenLabs. Retorna una Promise. */
  function hablarConElevenLabs(texto) {
    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: texto }),
    })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    })
    .then(function (blob) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.play();
      audio.onended = function () { URL.revokeObjectURL(url); };
      console.log('[tts] ElevenLabs reproduciendo:', texto);
    });
  }

  // ---------------------------------------------------------------------------
  // Browser TTS (fallback)
  // ---------------------------------------------------------------------------

  function obtenerVoces() {
    if (!('speechSynthesis' in window)) return [];
    return window.speechSynthesis.getVoices() || [];
  }

  function normalizarLang(lang) {
    return String(lang || '').toLowerCase().replace(/_/g, '-');
  }

  function elegirMejorVoz(voices) {
    if (!voices.length) return { voice: null, criterio: 'sin voces' };
    var ar = voices.find(function (v) {
      var l = normalizarLang(v.lang);
      return l === 'es-ar' || l.indexOf('es-ar') === 0;
    });
    if (ar) return { voice: ar, criterio: 'es-AR' };
    var latinCodes = ['es-419','es-mx','es-uy','es-cl','es-co','es-pe','es-ve','es-us'];
    for (var i = 0; i < latinCodes.length; i++) {
      var code = latinCodes[i];
      var found = voices.find(function (v) {
        var l = normalizarLang(v.lang);
        return l === code || l.indexOf(code + '-') === 0;
      });
      if (found) return { voice: found, criterio: 'es-latam (' + code + ')' };
    }
    var cualquierEs = voices.find(function (v) {
      return normalizarLang(v.lang).indexOf('es') === 0;
    });
    if (cualquierEs) return { voice: cualquierEs, criterio: 'cualquier es' };
    return { voice: null, criterio: 'motor predeterminado' };
  }

  function hablarConBrowser(texto) {
    if (!('speechSynthesis' in window)) return;
    var voices = obtenerVoces();
    var sel = elegirMejorVoz(voices);
    var u = new SpeechSynthesisUtterance(texto);
    u.rate = 1.1;
    if (sel.voice) { u.voice = sel.voice; u.lang = sel.voice.lang || 'es-AR'; }
    else { u.lang = 'es-AR'; }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    console.log('[speech] browser TTS:', texto, '| voz:', sel.criterio);
  }

  /** Punto de entrada principal: ElevenLabs si está configurado, browser TTS si no. */
  function hablarMonto(montoNumerico) {
    if (!vozActiva) return;
    var texto = construirTextoVoz(montoNumerico);
    if (elevenLabsDisponible) {
      hablarConElevenLabs(texto).catch(function (e) {
        console.warn('[tts] ElevenLabs falló, usando browser TTS:', e.message);
        hablarConBrowser(texto);
      });
    } else {
      hablarConBrowser(texto);
    }
  }

  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', function () {
      console.log('[speech] voces browser cargadas:', obtenerVoces().length);
    });
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  function mostrarOverlay(monto, mensaje, titularDisplay) {
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayMonto.textContent   = monto;
    overlayTexto.textContent   = mensaje || '';
    if (overlayTitular) overlayTitular.textContent = titularDisplay;
    overlay.classList.remove('oculto');
    overlayTimer = setTimeout(function () {
      overlay.classList.add('oculto');
      overlayTimer = null;
    }, 6000);
  }

  if (overlayClose) {
    overlayClose.addEventListener('click', function () {
      overlay.classList.add('oculto');
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    });
  }

  // ---------------------------------------------------------------------------
  // Marcar visto
  // ---------------------------------------------------------------------------

  function marcarVisto(id) {
    fetch('/api/eventos/' + encodeURIComponent(id) + '/visto', { method: 'PATCH' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) {
          actualizarVistoLocal(id);
        } else {
          console.warn('[ui] mark seen error:', j.error);
        }
      })
      .catch(function (e) { console.error('[ui] mark seen fetch:', e); });
  }

  function actualizarVistoLocal(id) {
    for (var i = 0; i < historialAlertas.length; i++) {
      if (historialAlertas[i].id === id) {
        historialAlertas[i].visto = true;
        break;
      }
    }
    actualizarBadge();
    // Actualiza solo el elemento del DOM sin re-renderizar todo
    var el = historialEl.querySelector('[data-id="' + id + '"]');
    if (el) {
      el.classList.add('visto');
      var btn = el.querySelector('.btn-visto');
      if (btn) btn.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Renderizar historial
  // ---------------------------------------------------------------------------

  function crearItemHistorial(item) {
    var div = document.createElement('div');
    div.className = 'historial-item' + (item.visto ? ' visto' : '');
    div.setAttribute('data-id', item.id);

    var t = labelTitular(item.titular);
    var orig = etiquetaOrigenCorta(item.origen);
    var montoFmt = formatearPesos(item.monto);
    var fechaStr = item.fecha
      ? new Date(item.fecha).toLocaleString('es-AR')
      : '—';

    var btnVitoHtml = item.visto
      ? '<span class="visto-label">✓ Visto</span>'
      : '<button class="btn-visto" data-id="' + escapeHtml(item.id) + '">Marcar visto</button>';

    div.innerHTML =
      '<div class="historial-top">' +
        '<span class="historial-origen" title="' + escapeHtml(String(item.origen || '')) + '">' + escapeHtml(orig) + '</span>' +
        '<div class="monto">' + escapeHtml(montoFmt) + '</div>' +
      '</div>' +
      '<div class="detalle titular-line">' + escapeHtml(t) + '</div>' +
      '<div class="detalle">' + escapeHtml(item.mensaje || '') + '</div>' +
      '<div class="detalle fecha">' + escapeHtml(fechaStr) + '</div>' +
      '<div class="historial-acciones">' +
        btnVitoHtml +
        '<button class="btn-replay" data-monto="' + escapeHtml(String(item.monto)) + '" title="Repetir sonido y voz">🔊 Repetir</button>' +
      '</div>';

    // Eventos de botones
    var btnV = div.querySelector('.btn-visto');
    if (btnV) {
      btnV.addEventListener('click', function () {
        marcarVisto(item.id);
      });
    }
    var btnR = div.querySelector('.btn-replay');
    if (btnR) {
      btnR.addEventListener('click', function () {
        var m = parseFloat(btnR.getAttribute('data-monto'));
        if (Number.isFinite(m)) {
          reproducirSonido();
          hablarMonto(m);
        }
      });
    }

    return div;
  }

  function renderHistorial() {
    historialEl.innerHTML = '';
    historialAlertas.forEach(function (item) {
      historialEl.appendChild(crearItemHistorial(item));
    });
    actualizarBadge();
  }

  // ---------------------------------------------------------------------------
  // Agregar alerta al estado + UI
  // ---------------------------------------------------------------------------

  function agregarAlerta(data, esNueva) {
    if (!esAlertaValida(data)) {
      console.warn('[ui] payload inválido ignorado:', data);
      return;
    }
    if (idsEnUI.has(data.id)) {
      // Si llegó por Socket y ya está en historial (cargado desde API), solo actualiza
      return;
    }
    idsEnUI.add(data.id);

    var item = {
      id:       data.id,
      monto:    data.monto,
      moneda:   data.moneda   || 'ARS',
      mensaje:  data.mensaje  || '',
      fecha:    data.fecha    || data.fecha_evento || new Date().toISOString(),
      origen:   data.origen   || '',
      titular:  data.titular  || '',
      provider: data.provider || '',
      visto:    data.visto    === true,
    };

    if (esNueva) {
      historialAlertas.unshift(item);
    } else {
      historialAlertas.push(item);
    }
    if (historialAlertas.length > MAX_HISTORIAL) historialAlertas.length = MAX_HISTORIAL;

    return item;
  }

  function mostrarAlertaNueva(data) {
    var item = agregarAlerta(data, true);
    if (!item) return;

    var montoFmt = formatearPesos(item.monto);
    var fechaStr = new Date(item.fecha).toLocaleString('es-AR');
    var titularLbl = labelTitular(item.titular);

    // Última alerta
    ultimaAlerta.classList.remove('vacia');
    ultimaAlerta.innerHTML =
      '<div class="ultima-inner">' +
        '<div><strong>' + escapeHtml(montoFmt) + '</strong></div>' +
        '<div class="ultima-titular">' + escapeHtml(titularLbl) + '</div>' +
        '<div>' + escapeHtml(item.mensaje || '') + '</div>' +
        '<div class="ultima-meta">' +
          '<span class="ultima-origen">' + escapeHtml(etiquetaOrigenCorta(item.origen)) + '</span> · ' +
          escapeHtml(fechaStr) +
        '</div>' +
      '</div>';

    // Prepend al DOM del historial (más eficiente que re-renderizar todo)
    var nuevoEl = crearItemHistorial(item);
    nuevoEl.classList.add('nueva');
    historialEl.insertBefore(nuevoEl, historialEl.firstChild);
    setTimeout(function () { nuevoEl.classList.remove('nueva'); }, 3000);

    actualizarBadge();
    mostrarOverlay(montoFmt, item.mensaje || '', titularLbl);
    reproducirSonido();
    hablarMonto(item.monto);
  }

  // ---------------------------------------------------------------------------
  // Cargar historial desde la API REST al conectar
  // ---------------------------------------------------------------------------

  function cargarHistorialDesdeAPI() {
    fetch('/api/eventos?limit=50')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !Array.isArray(j.eventos)) return;
        var eventos = j.eventos;
        eventos.forEach(function (ev) {
          agregarAlerta(ev, false);
        });
        // Ordena descendente por fecha (ya viene ordenado, pero por si acaso)
        historialAlertas.sort(function (a, b) {
          return new Date(b.fecha) - new Date(a.fecha);
        });
        renderHistorial();
        console.log('[ui] historial cargado desde API:', eventos.length, 'eventos');
      })
      .catch(function (e) {
        console.warn('[ui] no se pudo cargar historial desde API:', e.message);
      });
  }

  // ---------------------------------------------------------------------------
  // Socket.io — eventos
  // ---------------------------------------------------------------------------

  socket.on('connect', function () {
    console.log('[socket] conectado transport=', socket.io.engine.transport.name);
    setEstado('Conectado', 'online');
    // cargarHistorialDesdeAPI() se llama aquí para tener los datos en cuanto se conecta
    cargarHistorialDesdeAPI();
  });

  socket.on('disconnect', function (reason) {
    console.warn('[socket] disconnect reason=', reason);
    setEstado('Desconectado', 'offline');
  });

  socket.on('connect_error', function (err) {
    console.error('[socket] connect_error', err && err.message);
    setEstado('Error de conexión', 'offline');
  });

  socket.io.on('reconnect_attempt', function (n) {
    console.log('[socket] reconnect_attempt n=', n);
    setEstado('Reconectando…', 'reconnecting');
  });

  socket.io.on('reconnect', function (n) {
    console.log('[socket] reconnect ok intentos=', n);
    setEstado('Conectado', 'online');
  });

  socket.io.on('reconnect_failed', function () {
    console.error('[socket] reconnect_failed');
    setEstado('Sin conexión', 'offline');
  });

  /** Nueva transferencia en tiempo real */
  socket.on('nueva-transferencia', function (data) {
    try {
      console.log('[ui] nueva-transferencia id=', data && data.id, 'origen=', data && data.origen);
      mostrarAlertaNueva(data);
    } catch (e) {
      console.error('[ui] error procesando nueva-transferencia:', e);
    }
  });

  /**
   * Historial completo que envía el servidor al conectar.
   * Se usa como respaldo / sincronización si el fetch REST falló.
   */
  socket.on('historial-eventos', function (eventos) {
    if (!Array.isArray(eventos) || eventos.length === 0) return;
    // Solo carga los que no tenga ya (el fetch REST puede haber llegado antes)
    var nuevos = 0;
    eventos.forEach(function (ev) {
      if (!idsEnUI.has(ev.id)) {
        agregarAlerta(ev, false);
        nuevos++;
      }
    });
    if (nuevos > 0) {
      historialAlertas.sort(function (a, b) { return new Date(b.fecha) - new Date(a.fecha); });
      renderHistorial();
      console.log('[ui] historial-eventos socket:', nuevos, 'nuevos');
    }
  });

  /** Sincronización de "visto" entre pestañas/clientes */
  socket.on('evento-visto', function (data) {
    if (data && data.id) actualizarVistoLocal(data.id);
  });

  // ---------------------------------------------------------------------------
  // Prueba manual
  // ---------------------------------------------------------------------------

  if (btnPrueba) {
    btnPrueba.addEventListener('click', function () {
      var raw = (pruebaMonto && pruebaMonto.value) || '';
      var monto = Number(String(raw).replace(',', '.'));
      var body = {
        monto:    monto,
        mensaje:  (pruebaMensaje && pruebaMensaje.value) || '',
        titular:  (pruebaTitular && pruebaTitular.value) || '',
      };
      console.log('[ui] POST /api/alerta-prueba', body);

      fetch('/api/alerta-prueba', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json().then(function (j) { return { res: r, json: j }; }); })
        .then(function (ref) {
          if (!ref.res.ok) {
            console.error('[ui] alerta-prueba HTTP', ref.res.status, ref.json);
          } else {
            console.log('[ui] alerta-prueba ok', ref.json);
          }
        })
        .catch(function (e) { console.error('[ui] fetch alerta-prueba:', e); });
    });
  }

})();
