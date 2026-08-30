/* ============================================================================
   Radio ES — PWA reproductor de radio española online
   Lógica principal (Vanilla JS, ES6+).

   Funciones principales:
     init()               - arranque de la aplicación
     fetchStations()      - descarga de emisoras desde radio-browser.info
     renderStations()     - pinta la lista según pestaña y búsqueda
     playStation(id)      - reproduce una emisora
     toggleFavorite(id)   - marca/desmarca favoritos
     switchTheme()        - alterna tema claro/oscuro
     setupMediaSession()  - Media Session API (controles externos)
     setupServiceWorker() - registra sw.js
   ========================================================================== */

"use strict";

/* ---------------------------------------------------------------------------
   0. Constantes y estado global
   ------------------------------------------------------------------------- */

// Servidores públicos de radio-browser.info (rotamos en caso de fallo).
const RADIO_SERVERS = [
  "https://all.api.radio-browser.info",
  "https://de1.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
];

const STATION_LIMIT = 100;            // nº máx de emisoras por carga
const STORAGE_KEYS = {
  favorites: "radioes.favorites",     // array de stationuuid
  theme: "radioes.theme",             // 'light' | 'dark'
};

// URL del stream por defecto si la API no aporta uno usable.
const FALLBACK_STREAM = "https://icecast.rtve.es/radionacional.mp3";

// Elementos del DOM (se rellenan en init()).
const el = {};

// Estado de la app.
const state = {
  stations: [],           // todas las emisoras cargadas
  favorites: [],          // IDs (stationuuid) favoritas
  current: null,          // emisora en reproducción
  currentTab: "all",      // 'all' | 'favs'
  query: "",              // texto de búsqueda
  isLoading: false,       // bandera de carga inicial
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

/** Escribe en localStorage de forma segura. */
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("No se pudo guardar en localStorage:", e);
  }
}

/** Escapa texto para insertarlo de forma segura en HTML. */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
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

/** Devuelve una URL de API con servidores alternativos. */
function getApiBase() {
  return RADIO_SERVERS[Math.floor(Math.random() * RADIO_SERVERS.length)];
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
   3. Carga de emisoras desde radio-browser.info
   ------------------------------------------------------------------------- */

/**
 * Descarga las emisoras. Por defecto: país ES, con la etiqueta "radio",
 * ordenadas por popularidad (clickcount) de mayor a menor.
 */
async function fetchStations() {
  const params = new URLSearchParams({
    countrycode: "ES", // España
    tag: "radio",      // etiqueta radio
    order: "clickcount",
    reverse: "true",   // descendente (más populares primero)
    hidebroken: "true",
    limit: String(STATION_LIMIT),
  });

  let lastError;
  for (const base of RADIO_SERVERS) {
    try {
      const res = await fetch(`${base}/json/stations/search?${params}`, {
        headers: { "User-Agent": "RadioES-PWA/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) return data;
    } catch (err) {
      lastError = err;
      console.warn("Servidor API fallido:", base, err);
    }
  }
  throw lastError || new Error("No hay servidores disponibles");
}

/** Prepara las emisoras: descarta streams inválidos y normaliza campos. */
function normalizeStations(list) {
  const seen = new Set();
  return list
    .filter((s) => {
      if (!isValidStream(s.url_resolved) && !isValidStream(s.url)) return false;
      if (seen.has(s.stationuuid)) return false;
      seen.add(s.stationuuid);
      return true;
    })
    .map((s) => ({
      id: s.stationuuid,
      name: s.name || "Sin nombre",
      url: isValidStream(s.url_resolved) ? s.url_resolved : s.url,
      favicon: s.favicon || s.favicon_62 || "",
      tags: s.tags || "",
      language: s.language || "",
      codec: s.codec || "",
    }));
}

/* ---------------------------------------------------------------------------
   4. Renderizado de la lista
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

  const logo = station.favicon
    ? `<img src="${escapeHtml(station.favicon)}" alt="" loading="lazy"
          onerror="this.parentNode.querySelector('.ph').style.display='grid';this.style.display='none'">`
    : "";
  const ph = `<span class="ph"><i class="bx bx-radio"></i></span>`;

  const card = document.createElement("article");
  card.className = "station" + (isPlaying ? " playing" : "");
  card.dataset.id = station.id;

  card.innerHTML = `
    <button class="station-logo" type="button" data-action="play"
      aria-label="Reproducir ${escapeHtml(station.name)}">
      ${logo}${ph}
    </button>
    <div class="station-meta" data-action="play" role="button" tabindex="0"
      aria-label="Reproducir ${escapeHtml(station.name)}">
      <div class="station-name">${escapeHtml(station.name)}</div>
      <div class="station-sub">
        <i class="bx bx-signal-2"></i>
        <span>${escapeHtml(station.codec || "stream")} · ${escapeHtml(station.language || "ES")}</span>
      </div>
    </div>
    <button class="fav-btn ${isFav ? "on" : ""}" type="button" data-action="fav"
      aria-label="${isFav ? "Quitar de favoritas" : "Añadir a favoritas"}"
      aria-pressed="${isFav}">
      <i class="bx ${isFav ? "bxs-heart" : "bx-heart"}"></i>
    </button>
  `;

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

/** Pinta la lista completa en el DOM. */
function renderStations() {
  const listEl = el.stationList;
  listEl.innerHTML = "";
  const visible = getVisibleStations();

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
  visible.forEach((s) => frag.appendChild(stationCard(s)));
  listEl.appendChild(frag);

  updateFavCount();
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
  const card = el.stationList.querySelector(`.station[data-id="${id}"]`);
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

  // Si ya está sonando, solo reanudamos/ponemos play.
  if (state.current?.id === id && !el.audio.paused) return;

  state.current = station;
  updatePlayerUI(station, "Cargando…");
  renderStations(); // marca la tarjeta activa

  // Prepara la fuente del <audio>, con soporte HLS (.m3u8) vía hls.js.
  await setAudioSource(station.url);

  try {
    el.audio.play();
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
  // Limpia cualquier listener previo de timeupdate/error.
  el.audio.onerror = null;

  const isHls =
    /\.m3u8/i.test(url) ||
    (el.audio.canPlayType("application/vnd.apple.mpegurl") === "" &&
      url.includes("m3u8"));

  if (isHls) {
    // Reproducción nativa HLS (iOS/Safari modernos).
    if (el.audio.canPlayType("application/vnd.apple.mpegurl")) {
      el.audio.src = url;
      el.audio.onerror = handleAudioError;
      return Promise.resolve();
    }
    // Resto: cargar hls.js desde CDN de forma dinámica.
    return new Promise((resolve, reject) => {
      loadScript(
        "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"
      ).then(() => {
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
          el.audio.onerror = handleAudioError;
          resolve();
        }
      }, reject);
    });
  }

  // Stream normal (mp3/aac/ogg…).
  el.audio.src = url;
  el.audio.onerror = handleAudioError;
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
  resetPlayerUI();
  renderStations();
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

/** Manejador común de errores del stream. */
function handleAudioError() {
  setPlayerStatus("Error de conexión con la emisora");
  console.warn("Error de audio para:", state.current?.name);
}

/** Actualiza el panel inferior según el estado de reproducción. */
function updatePlayerUI(station, statusText) {
  el.player.hidden = false;
  el.playerTitle.textContent = station.name;

  const img = el.playerImg;
  const ph = el.player.querySelector(".placeholder-icon");
  if (station.favicon) {
    img.src = station.favicon;
    img.alt = "Logotipo de " + station.name;
    img.style.display = "block";
    ph.style.display = "none";
  } else {
    img.style.display = "none";
    ph.style.display = "grid";
  }

  setPlayerStatus(statusText || "Preparado");
  updatePlayPauseIcon();
}

/** Resetea el panel inferior al estado inicial. */
function resetPlayerUI() {
  el.playerTitle.textContent = "Sin emisora";
  setPlayerStatus("Pulsa para escuchar");
  el.playerImg.style.display = "none";
  el.player.querySelector(".placeholder-icon").style.display = "grid";
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
    ? [{ src: state.current.favicon, sizes: "512x512", type: "image/png" }]
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
    skeleton: document.getElementById("skeleton"),
    status: document.getElementById("status"),
    favCount: document.getElementById("fav-count"),
    player: document.getElementById("player"),
    playerTitle: document.getElementById("player-title"),
    playerStatus: document.getElementById("player-status"),
    playerImg: document.getElementById("player-img"),
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
      renderStations();
    });
  });

  // Buscador (filtro en vivo).
  el.searchInput.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    el.searchClear.hidden = !state.query;
    renderStations();
  });
  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    state.query = "";
    el.searchClear.hidden = true;
    renderStations();
    el.searchInput.focus();
  });

  // Controles del reproductor.
  el.playPause.addEventListener("click", togglePlayPause);
  el.playerStop.addEventListener("click", stopPlayback);

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

/** Punto de entrada principal. */
async function init() {
  cacheElements();
  applyTheme(getInitialTheme());
  bindEvents();

  // Recupera favoritos guardados.
  state.favorites = readStorage(STORAGE_KEYS.favorites, []);
  updateFavCount();

  // Registrar SW y Media Session antes de cargar datos.
  setupServiceWorker();
  setupMediaSession();

  // Carga las emisoras desde la API.
  el.skeleton.hidden = false;
  el.stationList.hidden = true;
  showStatus("Conectando con radio-browser.info…");

  try {
    state.stations = normalizeStations(await fetchStations());
    el.skeleton.hidden = true;
    el.stationList.hidden = false;
    showStatus("");
    renderStations();
    console.log(`Radio ES: ${state.stations.length} emisoras cargadas.`);
  } catch (err) {
    console.error("Error cargando emisoras:", err);
    el.skeleton.hidden = true;
    showStatus(
      "No se pudo conectar con radio-browser.info. Comprueba tu conexión e inténtalo de nuevo.",
      "error"
    );
    el.stationList.hidden = false;
    renderStations();
  }
}

// Arranca cuando el DOM esté listo.
document.addEventListener("DOMContentLoaded", init);
