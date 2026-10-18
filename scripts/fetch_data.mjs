// ŻulMapa - prebake danych OSM do data/<miasto>.json (uruchamiane w GitHub Actions)
// Node 20+, bez zależności. Overpass z mirrorami + Nominatim dla izb.
import { writeFile, mkdir } from "node:fs/promises";

const UA = "ZulMapa-data/1.0 (+https://github.com/pavelgajewski/zulmapa)";
const FETCH_RADIUS = 3000; // metry wokół centrum miasta
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const r5 = (x) => Math.round(x * 1e5) / 1e5;

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status + " (" + new URL(url).hostname + ")");
      return await res.json();
    } catch (e) { clearTimeout(t); lastErr = e; console.warn("Mirror padł:", String(e)); await sleep(2000); }
  }
  throw lastErr;
}

function parseElements(osm, into) {
  for (const el of osm.elements || []) {
    const pos = el.type === "node" ? [el.lat, el.lon] : (el.center ? [el.center.lat, el.center.lon] : null);
    if (!pos || pos[0] == null) continue;
    const p = [r5(pos[0]), r5(pos[1])];
    const t = el.tags || {};
    if (t.amenity === "police") into.police.push({ pos: p, name: t.name || "Posterunek" });
    else if (t.man_made === "surveillance") into.cameras.push({ pos: p });
    else into.green.push({ pos: p, name: t.name || (t.amenity === "shelter" ? "Altanka" :
      t.natural === "scrub" ? "Krzaki" : t.landuse === "cemetery" ? "Cmentarz (cisza gwarantowana)" :
      t.landuse === "allotments" ? "Ogródki działkowe" : "Teren zielony") });
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
  const qSmall = `[out:json][timeout:60];(nwr["amenity"="police"]${ar};node["man_made"="surveillance"]${ar};node["amenity"="shelter"]${ar};);out center;`;
  const qGreen = `[out:json][timeout:60];(way["leisure"~"^(park|garden)$"]${ar};way["natural"~"^(scrub|wood)$"]${ar};way["landuse"~"^(forest|meadow|grass|village_green|cemetery|allotments)$"]${ar};);out center;`;
  const data = { schema: 1, city: cityKey, generated_at: new Date().toISOString(), police: [], cameras: [], green: [], izby: [] };
  parseElements(await overpass(qSmall), data);
  await sleep(1500); // polityka Overpass: bez równoległości, przerwa między zapytaniami
  parseElements(await overpass(qGreen), data);
  data.izby = await geocodeIzby(cityKey);
  if (!data.police.length || !data.green.length)
    throw new Error(cityKey + ": podejrzanie puste dane (posterunki: " + data.police.length + ", zieleń: " + data.green.length + ") - nie nadpisuję");
  return data;
}

await mkdir("data", { recursive: true });
for (const cityKey of Object.keys(CITIES)) {
  console.log("Pobieram:", cityKey);
  const data = await buildCity(cityKey);
  await writeFile("data/" + cityKey + ".json", JSON.stringify(data));
  console.log(cityKey, "- posterunki:", data.police.length, "kamery:", data.cameras.length,
    "zieleń:", data.green.length, "izby:", data.izby.length);
  await sleep(1500);
}
console.log("Gotowe.");
