#!/usr/bin/env node
/* ============================================================================
   Radio ES — Conversor del catálogo de TDTChannels a stations.json

   TDTChannels (https://github.com/LaQuay/TDTChannels, Apache-2.0) mantiene
   una lista curada de emisoras de radio españolas con varios streams por
   emisora y logos. Este script la convierte al formato compacto que usa
   la app (stations.json).

   Uso:
     node scripts/build-catalog-tdt.mjs                # descarga RADIO.md
     node scripts/build-catalog-tdt.mjs RADIO.md       # usa un fichero local
   ========================================================================== */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TDT_URL =
  "https://raw.githubusercontent.com/LaQuay/TDTChannels/master/RADIO.md";
const OUT_PATH = new URL("../stations.json", import.meta.url);
const MAX_ALT = 2; // streams alternativos guardados por emisora

/** Quita tildes y convierte un nombre en slug estable. */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "emisora";
}

/** Prioridad de formatos: mp3 y aac son nativos en todos los móviles. */
const FORMAT_PRIORITY = { mp3: 0, aac: 1, stream: 2, m3u8: 3 };

/** Deduce el códec a partir del formato/enlace. */
function codecOf(format, url) {
  if (/\.m3u8/i.test(url)) return "HLS";
  if (format === "mp3" || /\.mp3/i.test(url)) return "MP3";
  if (format === "aac" || /\.aac/i.test(url)) return "AAC";
  return format ? format.toUpperCase() : "STREAM";
}

/** Extrae todos los enlaces [etiqueta](url) de una celda. */
function parseLinks(cell) {
  const links = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(cell)) !== null) {
    const label = m[1].split("#")[0].trim().toLowerCase();
    const url = m[2];
    if (/^https?:\/\//i.test(url)) links.push({ label, url });
  }
  return links;
}

/** Convierte RADIO.md (markdown de TDTChannels) en la lista de emisoras. */
function parseMarkdown(md) {
  const stations = [];
  const usedSlugs = new Set();

  let section = "";
  let region = "";

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("### ")) {
      region = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      region = "";
      continue;
    }
    if (!line.startsWith("|")) continue;

    const cells = line.split("|").map((c) => c.trim());
    // celdas: [0]='' [1]=nombre [2]=streams [3]=web [4]=logo [5]=epg [6]=info
    const name = (cells[1] || "").replace(/\s+/g, " ").trim();
    if (!name || name === "Emisoras" || /^-+$/.test(name)) continue;

    const streams = parseLinks(cells[2] || "");
    if (streams.length === 0) continue;

    // Logo: primer enlace http(s) de la celda "Logo".
    let favicon = "";
    const logoLink = parseLinks(cells[4] || "");
    if (logoLink.length > 0) favicon = logoLink[0].url;

    // Ordena los streams por preferencia de formato.
    streams.sort(
      (a, b) =>
        (FORMAT_PRIORITY[a.label] ?? 9) - (FORMAT_PRIORITY[b.label] ?? 9)
    );

    const primary = streams[0];
    const alt = streams
      .slice(1)
      .map((s) => s.url)
      .filter((u) => u !== primary.url)
      .slice(0, MAX_ALT);

    // Id estable a partir del nombre (los favoritos dependen de él).
    let slug = slugify(name);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);

    const tags = [section, region]
      .filter(Boolean)
      .map((t) =>
        t
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
      )
      .join(",");

    stations.push({
      id: `tdt-${slug}`,
      name,
      url: primary.url,
      alt,
      favicon,
      codec: codecOf(primary.label, primary.url),
      bitrate: 0,
      lang: "es",
      tags,
    });
  }

  return stations;
}

async function main() {
  const input = process.argv[2];
  let md;

  if (input) {
    md = await readFile(resolve(input), "utf8");
  } else {
    console.log(`Descargando ${TDT_URL} …`);
    const res = await fetch(TDT_URL, {
      headers: { "User-Agent": "RadioES-PWA/2.0 (catalog builder)" },
    });
    if (!res.ok) throw new Error(`No se pudo descargar RADIO.md (HTTP ${res.status})`);
    md = await res.text();
  }

  const stations = parseMarkdown(md);
  if (stations.length === 0) {
    console.error("No se ha encontrado ninguna emisora: revisa el formato.");
    process.exit(1);
  }

  const withLogo = stations.filter((s) => s.favicon).length;
  const withAlt = stations.filter((s) => s.alt.length > 0).length;

  const output = {
    generated_at: new Date().toISOString(),
    count: stations.length,
    source: "TDTChannels (https://github.com/LaQuay/TDTChannels) — Apache-2.0",
    stations,
  };

  await writeFile(OUT_PATH, JSON.stringify(output) + "\n", "utf8");

  const kb = Math.round(JSON.stringify(output).length / 1024);
  console.log(`✔ stations.json generado: ${stations.length} emisoras`);
  console.log(`  · ${withLogo} con logo (${Math.round((withLogo / stations.length) * 100)}%)`);
  console.log(`  · ${withAlt} con streams alternativos`);
  console.log(`  · ${kb} KB`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
