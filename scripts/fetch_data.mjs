// ŻulMapa - prebake danych OSM do data/<miasto>.json (uruchamiane w GitHub Actions)
// Node 20+, bez zależności. Overpass z mirrorami + Nominatim dla izb.
// v2: pełna geometria zieleni, filtr powierzchni, punkty wewnętrzne poligonów,
//     odrzucenie wiat przystankowych i kamer wewnątrz budynków. Format zgodny wstecz (schema 1 + nowe pola).
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const UA = "ZulMapa-data/2.0 (+https://github.com/pavelgajewski/zulmapa)";
const FETCH_RADIUS = 3000; // metry wokół centrum miasta
const OVERPASS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
const mirrorErrors = [];
const CITIES = {
  poznan: {
    name: "Poznań", center: [52.40816, 16.93425],
    izby: [{ name: "Ośrodek dla Osób Nietrzeźwych (MONAR)", addr: "ul. Podolańska 46, 60-626 Poznań",
      q: "Podolańska 46, Poznań", fallback: [52.43104, 16.89743] }]
  },
  lublin: {
    name: "Lublin", center: [51.25056, 22.56092],
    izby: [{ name: "Ośrodek Wczesnej Interwencji (izba wytrzeźwień, teren KMP)", addr: "ul. Północna 3, 20-064 Lublin",
      q: "Północna 3, Lublin", fallback: [51.26350, 22.55290] }]
  }
};
// Minimalna powierzchnia [m²] obiektu, żeby uznać go za kryjówkę (odcina pasy trawy przy ulicach)
const KINDS = {
  park:        { min: 1000, label: "Park" },
  garden:      { min: 3000, label: "Ogród" },
  wood:        { min: 500,  label: "Zadrzewienie" },
  forest:      { min: 500,  label: "Las" },
  scrub:       { min: 10,   label: "Krzaki" },   // wystarczy jeden duży krzak
  grass:       { min: 5000, label: "Duży trawnik" },
  village_green:{ min: 5000, label: "Skwer" },
  meadow:      { min: 2000, label: "Łąka" },
  cemetery:    { min: 2000, label: "Cmentarz (cisza gwarantowana)" },
  allotments:  { min: 2000, label: "Ogródki działkowe" }
};
const SHELTER_OK = new Set(["picnic_shelter", "gazebo", "lean_to", "basic_hut", "weather_shelter"]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/* ---------- geometria (lokalny układ metryczny wokół szerokości odniesienia) ---------- */
export function toXY(lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return {
    fwd: (p) => [p[1] * kx, p[0] * ky],          // [lat,lon] -> [x,y] m
    inv: (q) => [q[1] / ky, q[0] / kx]           // [x,y] -> [lat,lon]
  };
}
export function ringArea(ring) {                  // ring: [[x,y],...] zamknięty lub nie
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}
export function edgeDist(pt, rings) {
  let m = Infinity;
  for (const ring of rings) for (let i = 0, n = ring.length; i < n; i++) m = Math.min(m, segDist(pt, ring[i], ring[(i + 1) % n]));
  return m;
}
// Sklejanie fragmentów linii (członkowie multipoligonu) w zamknięte pierścienie
export function stitchRings(lines) {
  const key = (p) => p[0].toFixed(7) + "," + p[1].toFixed(7);
  const pool = lines.filter(l => l.length >= 2).map(l => l.slice());
  const rings = [];
  while (pool.length) {
    let cur = pool.shift();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 500) {
      const endK = key(cur[cur.length - 1]);
      const idx = pool.findIndex(l => key(l[0]) === endK || key(l[l.length - 1]) === endK);
      if (idx < 0) break;
      let nx = pool.splice(idx, 1)[0];
      if (key(nx[0]) !== endK) nx = nx.slice().reverse();
      cur = cur.concat(nx.slice(1));
    }
    if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur.slice(0, -1));
  }
  return rings;
}
// Punkty reprezentatywne: na pewno wewnątrz, posortowane od najgłębszego (najdalej od krawędzi)
export function interiorPoints(rings, maxPts = 5) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const G = 9, cand = [];
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const p = [minX + (i + .5) * (maxX - minX) / G, minY + (j + .5) * (maxY - minY) / G];
    if (rings.some(r => pointInRing(p, r))) cand.push({ p, d: edgeDist(p, rings) });
  }
  if (!cand.length) return [];
  cand.sort((a, b) => b.d - a.d);
  const out = [cand[0]];
  const minSep = Math.max(15, Math.sqrt((maxX - minX) * (maxY - minY)) / 4);
  for (const c of cand.slice(1)) {
    if (out.length >= maxPts) break;
    if (c.d < 3) continue;
    if (out.every(o => Math.hypot(o.p[0] - c.p[0], o.p[1] - c.p[1]) >= minSep)) out.push(c);
  }
  return out;
}

/* ---------- pobieranie ---------- */
async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 150000);
      try {
        const res = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
          signal: ctrl.signal
        });
        clearTimeout(t);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        const msg = new URL(url).hostname + " (próba " + attempt + "): " + (e && e.name === "AbortError" ? "timeout 150 s" : String(e && e.message || e));
        mirrorErrors.push(msg);
        console.warn("Mirror padł:", msg);
        await sleep(attempt * 3000);
      }
    }
  }
  throw lastErr;
}

function isTransitShelter(t) {
  return t.shelter_type === "public_transport" || t.public_transport || t.highway === "bus_stop" ||
    t.bus === "yes" || t.tram === "yes" || t.railway;
}
function parseSmall(osm, into, stats) {
  for (const el of osm.elements || []) {
    const pos = el.type === "node" ? [el.lat, el.lon] : (el.center ? [el.center.lat, el.center.lon] : null);
    if (!pos || pos[0] == null) continue;
    const p = [r5(pos[0]), r5(pos[1])];
    const t = el.tags || {};
    if (t.amenity === "police") into.police.push({ pos: p, name: t.name || "Posterunek" });
    else if (t.man_made === "surveillance") {
      if (t.surveillance === "indoor") { stats.cam_indoor++; continue; }
      into.cameras.push({ pos: p });
    } else if (t.natural === "shrub") {                 // pojedynczy krzak mapowany jako punkt
      stats.shrubs++;
      into.green.push({ pos: p, pts: [p], name: t.name || "Duży krzak", kind: "shrub", area: 0 });
    } else if (t.amenity === "shelter") {
      if (isTransitShelter(t) || !SHELTER_OK.has(t.shelter_type)) { stats.shelter_skipped++; continue; }
      into.green.push({ pos: p, pts: [p], name: t.name || "Altanka", kind: "shelter", area: 0 });
    }
  }
}
function kindOf(t) {
  if (t.leisure === "park") return "park";
  if (t.leisure === "garden") return "garden";
  if (t.natural === "wood") return "wood";
  if (t.natural === "scrub") return "scrub";
  if (t.landuse && KINDS[t.landuse]) return t.landuse;
  return null;
}
function parseGreen(osm, into, lat0, stats) {
  const T = toXY(lat0);
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    const kind = kindOf(t);
    if (!kind) continue;
    let rings = [];
    if (el.type === "way" && Array.isArray(el.geometry)) {
      const g = el.geometry.map(q => T.fwd([q.lat, q.lon]));
      if (g.length >= 4) rings = [g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1] ? g.slice(0, -1) : g];
    } else if (el.type === "relation" && Array.isArray(el.members)) {
      const outer = el.members.filter(m => m.type === "way" && (m.role === "outer" || m.role === "") && Array.isArray(m.geometry))
        .map(m => m.geometry.map(q => T.fwd([q.lat, q.lon])));
      rings = stitchRings(outer);
    }
    if (!rings.length) { stats.no_geom++; continue; }
    const area = rings.reduce((s, r) => s + ringArea(r), 0);
    if (area < KINDS[kind].min) { stats.too_small++; continue; }
    const ip = interiorPoints(rings, 5);
    if (!ip.length) { stats.no_interior++; continue; }
    const pts = ip.map(c => { const ll = T.inv(c.p); return [r5(ll[0]), r5(ll[1])]; });
    into.green.push({ pos: pts[0], pts, name: t.name || KINDS[kind].label, kind, area: Math.round(area) });
  }
}

async function geocodeIzby(cityKey) {
  const out = [];
  for (const iz of CITIES[cityKey].izby) {
    let pos = iz.fallback;
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=" +
        encodeURIComponent(iz.q), { headers: { "User-Agent": UA, "Accept": "application/json" } });
      if (r.ok) { const j = await r.json(); if (j[0]) pos = [parseFloat(j[0].lat), parseFloat(j[0].lon)]; }
    } catch (e) { console.warn("Nominatim padł dla", iz.q, "- zostaje wartość przybliżona"); }
    out.push({ name: iz.name, addr: iz.addr, pos: [r5(pos[0]), r5(pos[1])] });
    await sleep(1200); // polityka Nominatim: max 1 zapytanie/s
  }
  return out;
}

async function buildCity(cityKey) {
  const [lat, lon] = CITIES[cityKey].center;
  const ar = `(around:${FETCH_RADIUS},${lat},${lon})`;
  const qSmall = `[out:json][timeout:90];(nwr["amenity"="police"]${ar};node["man_made"="surveillance"]${ar};node["amenity"="shelter"]${ar};node["natural"="shrub"]${ar};);out center;`;
  const sel = (f) => `way${f}${ar};rel${f}${ar};`;
  const qGreen = `[out:json][timeout:150];(` +
    sel(`["leisure"~"^(park|garden)$"]`) + sel(`["natural"~"^(scrub|wood)$"]`) +
    sel(`["landuse"~"^(forest|meadow|grass|village_green|cemetery|allotments)$"]`) + `);out geom;`;
  const stats = { cam_indoor: 0, shelter_skipped: 0, shrubs: 0, no_geom: 0, too_small: 0, no_interior: 0 };
  const data = { schema: 1, version: 2, city: cityKey, generated_at: new Date().toISOString(), police: [], cameras: [], green: [], izby: [] };
  parseSmall(await overpass(qSmall), data, stats);
  await sleep(1500); // polityka Overpass: bez równoległości, przerwa między zapytaniami
  parseGreen(await overpass(qGreen), data, lat, stats);
  data.izby = await geocodeIzby(cityKey);
  if (!data.police.length || data.green.length < 30)
    throw new Error(cityKey + ": podejrzanie mało danych (posterunki: " + data.police.length + ", zieleń: " + data.green.length + ") - nie nadpisuję");
  data.filter_stats = stats;
  return data;
}

async function main() {
  await mkdir("data", { recursive: true });
  const status = { generated_at: new Date().toISOString(), version: 2, results: {}, filters: {}, mirror_errors: [] };
  for (const cityKey of Object.keys(CITIES)) {
    console.log("Pobieram:", cityKey);
    try {
      const data = await buildCity(cityKey);
      await writeFile("data/" + cityKey + ".json", JSON.stringify(data));
      status.results[cityKey] = "ok: posterunki " + data.police.length + ", kamery " + data.cameras.length +
        ", zieleń " + data.green.length + ", izby " + data.izby.length;
      status.filters[cityKey] = data.filter_stats;
      console.log(cityKey, "-", status.results[cityKey], JSON.stringify(data.filter_stats));
    } catch (e) {
      status.results[cityKey] = "błąd: " + String(e && e.message || e);
      console.error(cityKey, "-", status.results[cityKey]);
    }
    await sleep(1500);
  }
  status.mirror_errors = mirrorErrors;
  await writeFile("data/_status.json", JSON.stringify(status, null, 1));
  // Kod wyjścia 0: brak nowych danych nie psuje apki (zostają poprzednie paczki), _status.json mówi dlaczego.
  console.log("Status:", JSON.stringify(status.results));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
