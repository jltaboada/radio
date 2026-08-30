# Radio ES 📻

PWA **mobile-first** de reproductor de emisoras de radio españolas online, pensada para publicarse en **GitHub Pages**. Frontend puro, sin backend. Las emisoras se descargan en tiempo real desde la API gratuita [radio-browser.info](https://www.radio-browser.info/).

## Características

- 🎧 **Reproductor HTML5** persistente con Play/Pause/Stop.
- 📱 **PWA instalable** en Android (Chrome) e iOS (Safari).
- 🌙 **Modo claro/oscuro**: detecta el sistema y permite cambio manual (guardado en `localStorage`).
- 🔍 **Buscador** en vivo por nombre de emisora.
- ❤️ **Favoritos** guardados en `localStorage` con pestaña propia.
- 📶 **Media Session API**: controles en pantalla de bloqueo y notificaciones.
- 🧩 **hls.js** (CDN) para reproducir streams `.m3u8` en móviles.
- ⚡ **Service Worker** con estrategia "Cache First" (ignora los streams de audio).

## Estructura

```
/
├── index.html      # Estructura HTML5
├── styles.css      # CSS Mobile-First con variables para temas
├── app.js          # Lógica: Fetch API, Reproductor, Favoritos, Buscador, Temas
├── sw.js           # Service Worker (PWA/caché)
├── manifest.json   # Configuración de la PWA
└── /icons          # Iconos 192x192 y 512x512
```

Todas las rutas son relativas (`./`), por lo que funciona tanto en la raíz
(`usuario.github.io`) como en un subdirectorio (`usuario.github.io/radio/`).

## Desplegar en GitHub Pages

1. Crea un repositorio en GitHub y sube estos archivos.
2. Ve a **Settings → Pages**.
3. En *Build and deployment*, selecciona la rama `main` y la carpeta `/ (root)`.
4. Publica. En unos minutos estará en `https://<usuario>.github.io/<repo>/`.

> Instalación: abre la URL en el móvil, y en Chrome/Android usa "Instalar aplicación" o en iOS "Añadir a pantalla de inicio".

## Notas técnicas

- Las llamadas a la API usan **HTTPS** (evita errores de *Mixed Content*).
- Los streams de audio **no** se cachean en el Service Worker.
- hls.js se carga bajo demanda solo si la emisora usa formato HLS (`.m3u8`).
