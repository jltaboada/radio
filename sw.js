/* ============================================================================
   Radio ES — Service Worker (PWA)
   Estrategia: "Cache First, luego red" para activos de la interfaz.
   Los streams de audio se IGNORAN por completo (se reproducen en vivo).
   ========================================================================== */

"use strict";

const CACHE_VERSION = "radioes-v2";
const CACHE_NAME = `${CACHE_VERSION}-ui`;

// Activos precacheados al instalar (todas rutas relativas, funcionan
// tanto en la raíz del dominio como en un subdirectorio tipo GitHub Pages).
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

/* ---------------------------------------------------------------------------
   Instalación: crea la caché con el "app shell".
   ------------------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()) // activa el SW cuanto antes
  );
});

/* ---------------------------------------------------------------------------
   Activación: limpia cachés antiguas y toma el control.
   ------------------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("radioes-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------------------------------------------------------------------------
   Fetch: "Cache First, luego red".
   - Solo se cachean rutas del mismo origen (navegaciones y activos locales).
   - Se IGNORAN las peticiones cross-origin (API de radio-browser y, sobre
     todo, los streams de audio, que deben reproducirse en directo).
   ------------------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Ignorar métodos que no sean GET.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Peticiones a otros orígenes (CDN de iconos, hls.js, streams, API):
  // pasar directamente a la red, sin caché. Así nunca cacheamos audio.
  if (url.origin !== self.location.origin) return;

  // Catálogo de emisoras: "stale-while-revalidate". Se sirve la copia
  // caché al instante y se actualiza en segundo plano para la próxima vez.
  if (url.pathname.endsWith("/stations.json")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Navegaciones (documentos HTML): red primero, con respaldo de caché.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Activos estáticos: Cache First, luego red.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
