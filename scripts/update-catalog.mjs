#!/usr/bin/env node
/* ============================================================================
   Radio ES — Generador del catálogo embebido de emisoras (stations.json)

   Descarga las emisoras españolas más populares desde la API pública de
   radio-browser.info (hasta 1000, ocultando las rotas) y genera un
   stations.json compacto que la app carga al instante sin depender de
   la API en cada visita.

   Uso:  node scripts/update-catalog.mjs
   ========================================================================== */

import { writeFile } from "node:fs/promises";

const SERVERS = [
  "https://all.api.radio-browser.info",
  "https://de1.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
];

const LIMIT = 1000;   // tamaño máximo del catálogo
const PAGE = 200;     // tamaño de página de la API
const TIMEOUT_MS = 25000;
const OUT_PATH = new URL("../stations.json", import.meta.url);

/** ¿Es una URL http(s) válida? */
function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Descarga una página de resultados de la API. */
async function fetchPage(base, offset) {
  const params = new URLSearchParams({
    countrycode: "ES",
    order: "clickcount",   // orden por popularidad (clics), descendente
    reverse: "true",
    hidebroken: "true",    // sin emisoras caídas
    limit: String(PAGE),
    offset: String(offset),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/json/stations/search?${params}`, {
      headers: { "User-Agent": "RadioES-PWA/2.0 (catalog updater)" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("respuesta no válida");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Normaliza una emisora cruda de la API al formato compacto de la app. */
function toCompact(s) {
  const url = isHttpUrl(s.url_resolved) ? s.url_resolved : isHttpUrl(s.url) ? s.url : "";
  const name = String(s.name || "").trim().replace(/\s+/g, " ");
  if (!url || !name || !s.stationuuid) return null;

  let favicon = String(s.favicon || "").trim();
  if (favicon.startsWith("//")) favicon = "https:" + favicon;
  if (!isHttpUrl(favicon)) favicon = "";

  const lang = String(s.languagecodes || s.language || "")
    .split(",")[0].trim().slice(0, 8);
  const tags = String(s.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(",");

  return {
    id: s.stationuuid,
    name,
    url,
    favicon,
    codec: String(s.codec || "").toUpperCase().slice(0, 8),
    bitrate: Number(s.bitrate) || 0,
    lang,
    tags,
  };
}

async function main() {
  console.log("Descargando emisoras de España (radio-browser.info)…");

  let raw = [];
  let lastError = null;

  for (const base of SERVERS) {
    try {
      raw = [];
      for (let offset = 0; offset < LIMIT; offset += PAGE) {
        const page = await fetchPage(base, offset);
        raw.push(...page);
        console.log(`  ${base} · offset ${offset}: ${page.length} emisoras`);
        if (page.length < PAGE) break; // no hay más resultados
      }
      if (raw.length > 0) break; // este servidor ha funcionado
    } catch (err) {
      lastError = err;
      console.warn(`  ✗ ${base}: ${err.message}`);
    }
  }

  if (raw.length === 0) {
    console.error("No se pudo descargar ninguna emisora:", lastError?.message || "?");
    process.exit(1);
  }

  // Filtra, deduplica (por uuid y por nombre+stream) y compacta.
  const seenIds = new Set();
  const seenNameUrl = new Set();
  const stations = [];

  for (const s of raw) {
    const compact = toCompact(s);
    if (!compact) continue;
    const nameUrlKey = compact.name.toLowerCase() + "|" + compact.url;
    if (seenIds.has(compact.id) || seenNameUrl.has(nameUrlKey)) continue;
    seenIds.add(compact.id);
    seenNameUrl.add(nameUrlKey);
    stations.push(compact);
  }

  const withLogo = stations.filter((s) => s.favicon).length;

  const output = {
    generated_at: new Date().toISOString(),
    count: stations.length,
    stations,
  };

  await writeFile(OUT_PATH, JSON.stringify(output) + "\n", "utf8");

  const kb = Math.round(JSON.stringify(output).length / 1024);
  console.log(`✔ stations.json generado: ${stations.length} emisoras (${withLogo} con logo, ${kb} KB).`);
}

main().catch((err) => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
