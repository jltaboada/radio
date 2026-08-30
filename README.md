# Radio ES 📻

PWA **mobile-first** de reproductor de emisoras de radio españolas online, publicada en **GitHub Pages**. Frontend puro, sin backend.

**Catálogo embebido de ~1000 emisoras** con logos (`stations.json`, generado a partir de [TDTChannels](https://github.com/LaQuay/TDTChannels), licencia Apache-2.0): la app arranca al instante, sin depender de ninguna API externa. Como respaldo, si el catálogo no estuviera disponible, descarga emisoras en vivo de la API gratuita [radio-browser.info](https://www.radio-browser.info/).

## Características

- 📚 **Catálogo local de ~1000 emisoras** (nacionales, musicales, deportivas y de todas las comunidades autónomas) con **logo para el 100 %** de ellas.
- ⚡ **Arranque instantáneo**: el catálogo va incluido y lo sirve el Service Worker (funciona offline tras la primera visita).
- 🔁 **Streams alternativos**: muchas emisoras incluyen varias URLs; si una falla, la app prueba la siguiente automáticamente.
- 🎧 **Reproductor HTML5** persistente con Play/Pause/Stop.
- 🔤 **Avatares con la inicial** cuando un logo no carga o la emisora no tiene.
- 📱 **PWA instalable** en Android (Chrome) e iOS (Safari).
- 🌙 **Modo claro/oscuro**: detecta el sistema y permite cambio manual (guardado en `localStorage`).
- 🔍 **Buscador** en vivo por nombre de emisora.
- ❤️ **Favoritos** guardados en `localStorage` con pestaña propia.
- 📶 **Media Session API**: controles en pantalla de bloqueo y notificaciones.
- 🧩 **hls.js** (CDN) para reproducir streams `.m3u8` en móviles.
- ⚡ **Service Worker** con estrategia "Cache First" (ignora los streams de audio) y catálogo en "stale-while-revalidate".
- 📱 **Layout sin desbordes** en pantallas estrechas (probado hasta 320 px): nombres largos con elipsis, reproductor compacto en ≤360 px.
- 🚀 **Render progresivo**: la lista pinta por tandas de 60 con botón "Cargar más" y carga automática al hacer scroll (`content-visibility` para que ~1000 tarjetas vayan fluidas).

## Estructura

```
/
├── index.html                    # Estructura HTML5
├── styles.css                    # CSS Mobile-First con variables para temas
├── app.js                        # Lógica: catálogo, reproductor, favoritos, buscador
├── stations.json                 # Catálogo embebido (~1000 emisoras + logos)
├── sw.js                         # Service Worker (PWA/caché)
├── manifest.json                 # Configuración de la PWA
├── /icons                        # Iconos 192x192 y 512x512
├── /scripts
│   ├── build-catalog-tdt.mjs     # Regenera stations.json desde TDTChannels (principal)
│   └── update-catalog.mjs        # Alternativa: catálogo desde radio-browser.info
└── /docs
    └── update-catalog-workflow.yml  # Plantilla de GitHub Action (actualización semanal)
```

Todas las rutas son relativas (`./`), por lo que funciona tanto en la raíz (`usuario.github.io`) como en un subdirectorio (`usuario.github.io/radio/`).

## Regenerar el catálogo

Los streams de radio caducan con el tiempo. Para refrescar `stations.json`:

```bash
node scripts/build-catalog-tdt.mjs        # descarga la última lista de TDTChannels
node scripts/build-catalog-tdt.mjs RADIO.md  # o usa un fichero local
```

Y para que se actualice **solo cada semana**, activa el workflow de la plantilla `docs/update-catalog-workflow.yml` (las instrucciones están al principio del propio archivo; es copiar y pegar desde la web de GitHub).

> Alternativa: `node scripts/update-catalog.mjs` regenera el catálogo desde la API de radio-browser.info. ⚠️ Usa otro espacio de IDs, así que los favoritos guardados se perderían si mezclas fuentes.

## Desplegar en GitHub Pages

1. Haz fork o sube este repositorio a tu cuenta.
2. Ve a **Settings → Pages**.
3. En *Build and deployment*, selecciona la rama `main` y la carpeta `/ (root)`.
4. Publica. En unos minutos estará en `https://<usuario>.github.io/<repo>/`.

> Instalación: abre la URL en el móvil, y en Chrome/Android usa "Instalar aplicación" o en iOS "Añadir a pantalla de inicio".

## Notas técnicas

- Las llamadas a la API (solo respaldo) usan **HTTPS** (evita errores de *Mixed Content*).
- Los streams de audio **no** se cachean en el Service Worker.
- hls.js se carga bajo demanda solo si la emisora usa formato HLS (`.m3u8`).
- Datos del catálogo: [TDTChannels](https://github.com/LaQuay/TDTChannels) — Apache License 2.0.
