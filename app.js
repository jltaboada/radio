/* ============================================================================
   Radio ES — PWA reproductor de radio española online
   Lógica principal (Vanilla JS, ES6+).

   Funciones principales:
     init()                - arranque de la aplicación
     loadEmbeddedCatalog() - catálogo local (stations.json, ~1000 emisoras)
     fetchStations()       - respaldo: descarga desde radio-browser.info
     renderStations()      - pinta la lista por tandas (render progresivo)
     playStation(id)       - reproduce una emisora (con streams alternativos)
     toggleFavorite(id)    - marca/desmarca favoritos
     switchTheme()         - alterna tema claro/oscuro
     setupMediaSession()   - Media Session API (controles externos)
     setupServiceWorker()  - registra sw.js
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------- 
   0. Constantes y estado global
   ------------------------------------------------------------------------- */

// Catálogo embebido (generado con scripts/build-catalog-tdt.mjs a partir de
// TDTChannels). Se carga al instante y funciona incluso sin la API externa.
const CATALOG_PATH = "./stations.json";

// Servidores públicos de radio-browser.info (rotamos en caso de fallo).
// Solo se usan como respaldo cuando no hay catálogo embebido disponible.
const RADIO_SERVERS = [
  "https://all.api.radio-browser.info",
  "https://de1.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
];

const STATION_LIMIT = 1000;   // nº máx de emisoras desde la API en vivo
const FETCH_PAGE = 200;       // tamaño de página de la API
const RENDER_PAGE = 60;       // emisoras pintadas por tanda (render progresivo)
const SEARCH_DEBOUNCE = 120;  // ms de espera tras teclear en el buscador

const STORAGE_KEYS = {
  favorites: "radioes.favorites",     // array de ids de emisora
  theme: "radioes.theme",             // 'light' | 'dark'
};

// Elementos del DOM (se rellenan en init()).
const el = {};

// Estado de la app.
const state = {
  stations: [],           // todas las emisoras cargadas
  favorites: [],          // IDs favoritos
  current: null,          // emisora en reproducción
  currentUrls: [],        // URLs del stream actual (principal + alternativas)
  currentUrlIdx: 0,       // índice de la URL que se está probando
  currentTab: "all",      // 'all' | 'favs'
  query: "",              // texto de búsqueda
  renderedCount: 0,       // nº de tarjetas pintadas del filtro actual
};

/* ---------------------------------------------------------------------------
   1. Utilidades
   ------------------------------------------------------------------------- */

/** Lee una clave de localStorage de forma segura. */
function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    console.warn("No se pudo leer localStorage:", e);
    return fallback;
  }
}

/** Escribe una clave de localStorage de forma segura. */
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("No se pudo guardar localStorage:", e);
  }
}

/** Escapa texto para insertarlo de forma segura en HTML (incluidas comillas). */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML.replace(/"/g, "&quot;");
}

/** Normaliza un texto para búsquedas (minúsculas, sin tildes). */
function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Comprueba que una URL sea http(s) y no deje el app en estado roto. */
function isValidStream(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** Letra inicial + tono de color determinista (avatar cuando no hay logo). */
function letterAvatar(name) {
  const clean = String(name || "").trim();
  const letter = (clean[0] || "R").toUpperCase();
  let hue = 7;
  for (const ch of clean) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  return { letter, hue };
}

/** fetch con timeout (AbortController). */
function fetchWithTimeout(url, ms, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
  });
}

/* ---------------------------------------------------------------------------
   2. Gestión del tema (claro / oscuro)
   ------------------------------------------------------------------------- */

/**
 * Aplica el tema: 1º preferencia guardada en localStorage, si no existe
 * detecta la del sistema operativo (prefers-color-scheme).
 */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);

  // Actualiza el icono y el <meta theme-color> (solo cosmético).
  const icon = el.themeToggle?.querySelector("i");
  if (icon) {
    icon.className = theme === "dark" ? "bx bx-sun" : "bx bx-moon";
  }
  const meta = document.getElementById("meta-theme-color");
  if (meta) {
    meta.setAttribute("content", theme === "dark" ? "#16161e" : "#f4f5f7");
  }
}

/** Determina el tema inicial (guardado o del sistema). */
function getInitialTheme() {
  const saved = readStorage(STORAGE_KEYS.theme, null);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Alterna manualmente entre claro y oscuro y lo guarda. */
function switchTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  writeStorage(STORAGE_KEYS.theme, next);
}

/* ---------------------------------------------------------------------------
   3. Carga de emisoras
   ------------------------------------------------------------------------- */

/**
 * Carga el catálogo embebido (stations.json). Devuelve null si no existe,
 * está corrupto o no tiene emisoras.
 */
async function loadEmbeddedCatalog() {
  try {
    const res = await fetch(CATALOG_PATH);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.stations)) return null;

    const seen = new Set();
    const list = [];
    for (const s of data.stations) {
      if (!s || !s.id || !isValidStream(s.url) || seen.has(s.id)) continue;
      seen.add(s.id);
      let favicon = String(s.favicon || "");
      if (favicon.startsWith("//")) favicon = "https:" + favicon;
      list.push({
        id: s.id,
        name: String(s.name || "Sin nombre"),
        url: s.url,
        alt: Array.isArray(s.alt) ? s.alt.filter(isValidStream).slice(0, 3) : [],
        favicon: isValidStream(favicon) ? favicon : "",
        codec: String(s.codec || ""),
        bitrate: Number(s.bitrate) || 0,
        lang: String(s.lang || "es"),
        tags: String(s.tags || ""),
      });
    }
    return list.length > 0 ? list : null;
  } catch (err) {
    console.warn("Catálogo embebido no disponible:", err);
    return null;
  }
}

/**
 * Respaldo: descarga emisoras en vivo desde radio-browser.info,
 * por páginas y con renderizado progresivo (onBatch recibe el acumulado).
 */
async function fetchStations(onBatch = null) {
  let lastError;

  for (const base of RADIO_SERVERS) {
    try {
      const collected = [];
      for (let offset = 0; offset < STATION_LIMIT; offset += FETCH_PAGE) {
        const params = new URLSearchParams({
          countrycode: "ES",   // España
          order: "clickcount", // popularidad (clics)
          reverse: "true",     // más populares primero
          hidebroken: "true",  // sin emisoras caídas
          limit: String(FETCH_PAGE),
          offset: String(offset),
        });
        const res = await fetchWithTimeout(
          `${base}/json/stations/search?${params}`,
          15000,
          { headers: { "User-Agent": "RadioES-PWA/2.0" } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Respuesta inválida");

        collected.push(...data);
        if (onBatch) onBatch(collected);
        if (data.length < FETCH_PAGE) break; // no hay más resultados
      }
      if (collected.length > 0) return collected;
    } catch (err) {
      lastError = err;
      console.warn("Servidor API fallido:", base, err);
    }
  }
  throw lastError || new Error("No hay servidores disponibles");
}

/** Prepara emisoras de la API: descarta streams inválidos y normaliza campos. */
function normalizeStations(list) {
  const seen = new Set();
  return list
    .filter((s) => {
      if (!isValidStream(s.url_resolved) && !isValidStream(s.url)) return false;
      if (seen.has(s.stationuuid)) return false;
      seen.add(s.stationuuid);
      return true;
    })
    .map((s) => {
      let favicon = String(s.favicon || s.favicon_62 || "");
      if (favicon.startsWith("//")) favicon = "https:" + favicon;
      return {
        id: s.stationuuid,
        name: String(s.name || "Sin nombre").trim() || "Sin nombre",
        url: isValidStream(s.url_resolved) ? s.url_resolved : s.url,
        alt: [],
        favicon: isValidStream(favicon) ? favicon : "",
        codec: String(s.codec || "").toUpperCase(),
        bitrate: Number(s.bitrate) || 0,
        lang:
          String(s.languagecodes || s.language || "")
            .split(",")[0]
            .trim()
            .slice(0, 8) || "es",
        tags: String(s.tags || ""),
      };
    });
}

/* ---------------------------------------------------------------------------
   4. Renderizado de la lista (progresivo, por tandas)
   ------------------------------------------------------------------------- */

/** Devuelve las emisoras a mostrar según pestaña y búsqueda. */
function getVisibleStations() {
  let list = state.stations;
  if (state.currentTab === "favs") {
    list = list.filter((s) => state.favorites.includes(s.id));
  }
  if (state.query) {
    const q = normalize(state.query);
    list = list.filter((s) => normalize(s.name).includes(q));
  }
  return list;
}

/** Crea el nodo HTML de una tarjeta de emisora. */
function stationCard(station) {
  const isFav = state.favorites.includes(station.id);
  const isPlaying = state.current?.id === station.id;

  const { letter, hue } = letterAvatar(station.name);
  const logoInner = station.favicon
    ? `<img src="${escapeHtml(station.favicon)}" alt="" loading="lazy" decoding="async">`
    : `<span class="ph ph-letter" style="--h:${hue}">${escapeHtml(letter)}</span>`;

  const card = document.createElement("article");
  card.className = "station" + (isPlaying ? " playing" : "");
  card.dataset.id = station.id;

  card.innerHTML = `
    <button class="station-logo" type="button" data-action="play"
      aria-label="Reproducir ${escapeHtml(station.name)}">
      ${logoInner}
    </button>
    <div class="station-meta" data-action="play" role="button" tabindex="0"
      aria-label="Reproducir ${escapeHtml(station.name)}">
      <div class="station-name">${escapeHtml(station.name)}</div>
      <div class="station-sub">
        <i class="bx bx-signal-2"></i>
        <span>${escapeHtml(station.codec || "stream")}${station.bitrate ? " · " + station.bitrate + " kbps" : ""} · ${escapeHtml(station.lang || "es")}</span>
      </div>
    </div>
    <button class="fav-btn ${isFav ? "on" : ""}" type="button" data-action="fav"
      aria-label="${isFav ? "Quitar de favoritas" : "Añadir a favoritas"}"
      aria-pressed="${isFav}">
      <i class="bx ${isFav ? "bxs-heart" : "bx-heart"}"></i>
    </button>
  `;

  // Si el logo falla (404, mixto…), se sustituye por el avatar con la inicial.
  const img = card.querySelector(".station-logo img");
  if (img) {
    img.addEventListener(
      "error",
      () => {
        const span = document.createElement("span");
        span.className = "ph ph-letter";
        span.style.setProperty("--h", String(hue));
        span.textContent = letter;
        img.replaceWith(span);
      },
      { once: true }
    );
  }

  // Delegación de clics dentro de la tarjeta.
  card.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "play") playStation(station.id);
    else if (action === "fav") toggleFavorite(station.id);
  });
  // Soportar teclado en el área de meta.
  card.querySelector(".station-meta").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      playStation(station.id);
    }
  });

  return card;
}

/** Pinta la lista en el DOM respetando el nº de tarjetas ya expandidas. */
function renderStations() {
  const listEl = el.stationList;
  listEl.innerHTML = "";
  const visible = getVisibleStations();

  updateTotalCount(visible.length);
  updateLoadMore(visible.length);

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = state.currentTab === "favs"
      ? `<i class="bx bx-heart"></i><p>No tienes emisoras favoritas todavía.<br>Toca el corazón para guardarlas.</p>`
      : `<i class="bx bx-search-alt"></i><p>No se han encontrado emisoras con "<b>${escapeHtml(state.query)}</b>".</p>`;
    listEl.appendChild(empty);
    return;
  }

  // Fragment para un único repintado eficiente.
  const frag = document.createDocumentFragment();
  const count = Math.min(state.renderedCount, visible.length);
  for (let i = 0; i < count; i++) frag.appendChild(stationCard(visible[i]));
  listEl.appendChild(frag);
}

/** Reinicia el render a la primera tanda (cambio de pestaña/búsqueda). */
function resetRender() {
  state.renderedCount = RENDER_PAGE;
  renderStations();
}

/** Añade la siguiente tanda de tarjetas al final de la lista. */
function appendNextPage() {
  const visible = getVisibleStations();
  if (state.renderedCount >= visible.length) {
    updateLoadMore(visible.length);
    return;
  }
  const frag = document.createDocumentFragment();
  const end = Math.min(state.renderedCount + RENDER_PAGE, visible.length);
  for (let i = state.renderedCount; i < end; i++) {
    frag.appendChild(stationCard(visible[i]));
  }
  el.stationList.appendChild(frag);
  state.renderedCount = end;
  updateLoadMore(visible.length);
}

/** Muestra/oculta el botón "Cargar más" según queden emisoras por pintar. */
function updateLoadMore(visibleLength = getVisibleStations().length) {
  const remaining = visibleLength - state.renderedCount;
  const more = remaining > 0 && state.renderedCount > 0;
  el.loadMore.hidden = !more;
  if (more) {
    el.loadMore.textContent = `Cargar más (${remaining} restantes)`;
  }
}

/** Actualiza el contador de la pestaña "Todas". */
function updateTotalCount(count = state.stations.length) {
  if (count > 0) {
    el.totalCount.hidden = false;
    el.totalCount.textContent = count > 99 ? count.toLocaleString("es-ES") : String(count);
  } else {
    el.totalCount.hidden = true;
  }
}

/** Actualiza el contador de favoritos de la pestaña. */
function updateFavCount() {
  const count = state.favorites.length;
  const badge = el.favCount;
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : count;
  } else {
    badge.hidden = true;
  }
}

/** Marca quirúrgicamente la tarjeta en reproducción (sin repintar la lista). */
function updatePlayingCard() {
  el.stationList
    .querySelectorAll(".station.playing")
    .forEach((c) => c.classList.remove("playing"));
  if (state.current) {
    const card = el.stationList.querySelector(
      `.station[data-id="${CSS.escape(state.current.id)}"]`
    );
    card?.classList.add("playing");
  }
}

/* ---------------------------------------------------------------------------
   5. Favoritos
   ------------------------------------------------------------------------- */

/** Marca/desmarca una emisora como favorita y guarda en localStorage. */
function toggleFavorite(id) {
  const idx = state.favorites.indexOf(id);
  if (idx === -1) state.favorites.push(id);
  else state.favorites.splice(idx, 1);

  writeStorage(STORAGE_KEYS.favorites, state.favorites);

  // Actualiza el estado visual del botón en la tarjeta (si existe).
  const card = el.stationList.querySelector(`.station[data-id="${CSS.escape(id)}"]`);
  if (card) {
    const btn = card.querySelector(".fav-btn");
    const icon = btn.querySelector("i");
    const isFav = state.favorites.includes(id);
    btn.classList.toggle("on", isFav);
    btn.setAttribute("aria-pressed", String(isFav));
    btn.setAttribute("aria-label", isFav ? "Quitar de favoritas" : "Añadir a favoritas");
    icon.className = isFav ? "bx bxs-heart" : "bx bx-heart";
  }
  updateFavCount();

  // Si estamos en la pestaña de favoritas y se acaba de desmarcar, se oculta.
  if (state.currentTab === "favs") renderStations();
}

/* ---------------------------------------------------------------------------
   6. Reproductor de audio (HTML5 + hls.js para .m3u8)
   ------------------------------------------------------------------------- */

/** Carga el stream de una emisora y empieza a reproducirla. */
async function playStation(id) {
  const station = state.stations.find((s) => s.id === id);
  if (!station) return;

  // Si ya es la emisora actual: reanudar si está en pausa.
  if (state.current?.id === id) {
    if (el.audio.paused) {
      try {
        await el.audio.play();
      } catch (err) {
        console.warn("No se pudo reanudar la reproducción:", err);
        setPlayerStatus("Toca de nuevo para reproducir");
      }
    }
    return;
  }

  state.current = station;
  // Streams a probar: el principal y luego los alternativos del catálogo.
  state.currentUrls = [station.url, ...(station.alt || [])].filter(
    (u, i, arr) => isValidStream(u) && arr.indexOf(u) === i
  );
  state.currentUrlIdx = 0;

  updatePlayerUI(station, "Cargando…");
  updatePlayingCard();

  await setAudioSource(state.currentUrls[0]);

  try {
    await el.audio.play();
  } catch (err) {
    console.warn("No se pudo iniciar la reproducción:", err);
    setPlayerStatus("Toca de nuevo para reproducir");
  }
}

/**
 * Configura la fuente del elemento <audio>.
 * - Formato HLS (.m3u8) → usa hls.js (CDN) para mayor compatibilidad en iOS.
 * - Resto de formatos (mp3, aac, ogg…) → nativo HTML5.
 */
function setAudioSource(url) {
  const isHls = /\.m3u8(\?|$)/i.test(url) || url.toLowerCase().includes("m3u8");

  if (isHls) {
    // Reproducción nativa HLS (iOS/Safari modernos).
    if (el.audio.canPlayType("application/vnd.apple.mpegurl")) {
      el.audio.src = url;
      return Promise.resolve();
    }
    // Resto: cargar hls.js desde CDN de forma dinámica.
    return new Promise((resolve, reject) => {
      loadScript("https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js").then(
        () => {
          if (!window.Hls) {
            reject(new Error("hls.js no disponible"));
            return;
          }
          if (window.Hls.isSupported()) {
            const hls = new window.Hls({ enableWorker: true });
            hls.loadSource(url);
            hls.attachMedia(el.audio);
            hls.on(window.Hls.Events.ERROR, (_evt, data) => {
              if (data.fatal) handleAudioError();
            });
            resolve();
          } else {
            // Último recurso: dejar que el navegador lo intente de forma nativa.
            el.audio.src = url;
            resolve();
          }
        },
        reject
      );
    });
  }

  // Stream normal (mp3/aac/ogg…).
  el.audio.src = url;
  return Promise.resolve();
}

/** Carga dinámica de un <script> externo (para hls.js). */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Fallo al cargar: " + src));
    document.head.appendChild(script);
  });
}

/** Detiene la reproducción actual por completo. */
function stopPlayback() {
  el.audio.pause();
  el.audio.removeAttribute("src");
  el.audio.load();
  state.current = null;
  state.currentUrls = [];
  state.currentUrlIdx = 0;
  resetPlayerUI();
  updatePlayingCard();
}

/** Alterna reproducir/pausar la emisora actual. */
function togglePlayPause() {
  if (!state.current) return;
  if (el.audio.paused) {
    el.audio.play().catch(() => setPlayerStatus("Toca de nuevo para reproducir"));
  } else {
    el.audio.pause();
  }
}

/**
 * Manejador de errores del stream: antes de rendirse, prueba las URLs
 * alternativas de la emisora (el catálogo incluye varias cuando existen).
 */
function handleAudioError() {
  if (
    state.current &&
    state.currentUrlIdx < state.currentUrls.length - 1
  ) {
    state.currentUrlIdx += 1;
    setPlayerStatus("Probando otra conexión…");
    setAudioSource(state.currentUrls[state.currentUrlIdx])
      .then(() => el.audio.play())
      .catch(() => setPlayerStatus("Error de conexión con la emisora"));
    return;
  }
  setPlayerStatus("Error de conexión con la emisora");
  console.warn("Error de audio para:", state.current?.name);
}

/** Actualiza el panel inferior según el estado de reproducción. */
function updatePlayerUI(station, statusText) {
  el.player.hidden = false;
  el.playerTitle.textContent = station.name;
  setPlayerArt(station);
  setPlayerStatus(statusText || "Preparado");
  updatePlayPauseIcon();
}

/** Coloca el logo (o avatar con inicial) del reproductor. */
function setPlayerArt(station) {
  const img = el.playerImg;
  const ph = el.player.querySelector(".placeholder-icon");
  const letterBox = el.playerLetter;

  if (station.favicon) {
    img.src = station.favicon;
    img.alt = "Logotipo de " + station.name;
    img.style.display = "block";
    ph.style.display = "none";
    letterBox.hidden = true;
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    ph.style.display = "none";
    showPlayerLetter(station);
  }
}

/** Muestra el avatar con la inicial en el reproductor. */
function showPlayerLetter(station) {
  const { letter, hue } = letterAvatar(station.name);
  el.playerLetter.style.setProperty("--h", String(hue));
  el.playerLetter.textContent = letter;
  el.playerLetter.hidden = false;
}

/** Resetea el panel inferior al estado inicial. */
function resetPlayerUI() {
  el.playerTitle.textContent = "Sin emisora";
  setPlayerStatus("Pulsa para escuchar");
  el.playerImg.removeAttribute("src");
  el.playerImg.style.display = "none";
  el.player.querySelector(".placeholder-icon").style.display = "grid";
  el.playerLetter.hidden = true;
  el.playerNow.hidden = true;
  updatePlayPauseIcon();
}

/** Muestra el estado del reproductor (cargando / reproduciendo…). */
function setPlayerStatus(text) {
  el.playerStatus.textContent = text;
  if (text === "Reproduciendo en directo") {
    el.playerNow.hidden = false;
  } else {
    el.playerNow.hidden = true;
  }
  updatePlayPauseIcon();
}

/** Sincroniza el icono Play/Pause con el estado real del audio. */
function updatePlayPauseIcon() {
  const icon = el.playPause.querySelector("i");
  icon.className = el.audio.paused ? "bx bx-play" : "bx bx-pause";
}

/* ---------------------------------------------------------------------------
   7. Media Session API (pantalla de bloqueo / notificaciones)
   ------------------------------------------------------------------------- */

/** Activa los controles externos del sistema (lock screen, Android/iOS). */
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const playback = () => {
    if (el.audio.paused) el.audio.play();
    else el.audio.pause();
  };

  navigator.mediaSession.setActionHandler("play", playback);
  navigator.mediaSession.setActionHandler("pause", playback);
  navigator.mediaSession.setActionHandler("previoustrack", stopPlayback);
  navigator.mediaSession.setActionHandler("nexttrack", stopPlayback);
  // iOS requiere "stop" como acción de detención.
  try {
    navigator.mediaSession.setActionHandler("stop", stopPlayback);
  } catch (e) { /* no soportado en algunos navegadores */ }
}

/** Actualiza la metadata mostrada en el Media Session. */
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  if (!state.current) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const artwork = state.current.favicon
    ? [{ src: state.current.favicon, sizes: "512x512" }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.name,
    artist: "Radio ES",
    album: "Radio española en directo",
    artwork,
  });
}

/* ---------------------------------------------------------------------------
   8. Service Worker (PWA)
   ------------------------------------------------------------------------- */

/** Registra el Service Worker (solo si el navegador lo soporta). */
function setupServiceWorker() {
  if ("serviceWorker" in navigator) {
    // reloadOnUpdate: evita tener dos versiones de la app en uso.
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            console.log("Nueva versión disponible. Recarga para actualizar.");
          }
        });
      });
    }).catch((err) => console.warn("Service Worker no registrado:", err));
  }
}

/* ---------------------------------------------------------------------------
   9. Inicialización y eventos
   ------------------------------------------------------------------------- */

/** Referencia todos los elementos del DOM. */
function cacheElements() {
  Object.assign(el, {
    themeToggle: document.getElementById("theme-toggle"),
    searchInput: document.getElementById("search-input"),
    searchClear: document.getElementById("search-clear"),
    stationList: document.getElementById("station-list"),
    loadMore: document.getElementById("load-more"),
    skeleton: document.getElementById("skeleton"),
    status: document.getElementById("status"),
    favCount: document.getElementById("fav-count"),
    totalCount: document.getElementById("total-count"),
    player: document.getElementById("player"),
    playerTitle: document.getElementById("player-title"),
    playerStatus: document.getElementById("player-status"),
    playerImg: document.getElementById("player-img"),
    playerLetter: document.getElementById("player-letter"),
    playerNow: document.getElementById("player-now"),
    playerStop: document.getElementById("player-stop"),
    playPause: document.getElementById("player-playpause"),
    audio: document.getElementById("audio"),
  });
}

/** Muestra un mensaje de estado (loading / error). */
function showStatus(message, type = "") {
  el.status.hidden = !message;
  el.status.className = "status" + (type ? " " + type : "");
  el.status.textContent = message;
}

/** Vincula todos los eventos de la interfaz. */
function bindEvents() {
  // Tema.
  el.themeToggle.addEventListener("click", switchTheme);

  // Tabs.
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.currentTab = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      });
      resetRender();
    });
  });

  // Buscador (filtro en vivo, con pequeño debounce).
  let searchTimer = null;
  el.searchInput.addEventListener("input", (e) => {
    const value = e.target.value.trim();
    el.searchClear.hidden = !value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value;
      resetRender();
    }, SEARCH_DEBOUNCE);
  });
  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    el.searchClear.hidden = true;
    state.query = "";
    resetRender();
    el.searchInput.focus();
  });

  // "Cargar más" manual + automático al llegar al final.
  el.loadMore.addEventListener("click", appendNextPage);
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) appendNextPage();
      },
      { rootMargin: "700px 0px" }
    );
    io.observe(el.loadMore);
  }

  // Controles del reproductor.
  el.playPause.addEventListener("click", togglePlayPause);
  el.playerStop.addEventListener("click", stopPlayback);

  // Si el logo del reproductor falla → avatar con la inicial.
  el.playerImg.addEventListener("error", () => {
    if (state.current) {
      el.playerImg.style.display = "none";
      showPlayerLetter(state.current);
    }
  });

  // Estado del audio → sincroniza iconos y Media Session.
  el.audio.addEventListener("playing", () => {
    setPlayerStatus("Reproduciendo en directo");
    updateMediaSession();
    updatePlayPauseIcon();
  });
  el.audio.addEventListener("pause", updatePlayPauseIcon);
  el.audio.addEventListener("ended", stopPlayback);
  el.audio.addEventListener("error", handleAudioError);

  // Atajos de teclado (espacio para play/pause).
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.matches("input, textarea")) {
      e.preventDefault();
      togglePlayPause();
    }
  });
}

/**
 * Arranque:
 * 1. Catálogo embebido (instantáneo, funciona offline tras la 1ª visita).
 * 2. Si no existe → API en vivo con renderizado progresivo.
 */
async function init() {
  cacheElements();
  applyTheme(getInitialTheme());
  bindEvents();

  // Recupera favoritos guardados.
  state.favorites = readStorage(STORAGE_KEYS.favorites, []);
  if (!Array.isArray(state.favorites)) state.favorites = [];
  updateFavCount();

  // Registrar SW y Media Session antes de cargar datos.
  setupServiceWorker();
  setupMediaSession();

  el.skeleton.hidden = false;
  el.stationList.hidden = true;

  // 1) Catálogo embebido.
  const catalog = await loadEmbeddedCatalog();
  if (catalog) {
    state.stations = catalog;
    state.renderedCount = RENDER_PAGE;
    el.skeleton.hidden = true;
    el.stationList.hidden = false;
    renderStations();
    console.log(`Radio ES: ${state.stations.length} emisoras del catálogo local.`);
    return;
  }

  // 2) Respaldo: API en vivo.
  showStatus("Conectando con radio-browser.info…");
  let first = true;
  try {
    const raw = await fetchStations((cumulative) => {
      state.stations = normalizeStations(cumulative);
      if (first && state.stations.length > 0) {
        first = false;
        el.skeleton.hidden = true;
        el.stationList.hidden = false;
        showStatus("");
        state.renderedCount = RENDER_PAGE;
      }
      if (!first) renderStations();
    });
    state.stations = normalizeStations(raw);
    el.skeleton.hidden = true;
    el.stationList.hidden = false;
    showStatus("");
    if (first) {
      state.renderedCount = RENDER_PAGE;
      renderStations();
    }
    console.log(`Radio ES: ${state.stations.length} emisoras de radio-browser.info.`);
  } catch (err) {
    console.error("Error cargando emisoras:", err);
    el.skeleton.hidden = true;
    showStatus(
      "No se pudo cargar el catálogo de emisoras. Comprueba tu conexión e inténtalo de nuevo.",
      "error"
    );
    el.stationList.hidden = false;
    renderStations();
  }
}

// Arranca cuando el DOM esté listo.
document.addEventListener("DOMContentLoaded", init);
