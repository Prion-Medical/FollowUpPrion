// Wat een contactmoment met de opvolging doet, beslist sinds issue 21 de
// databank (opvolging_bijwerken() in supabase/schema.sql). De app houdt haar
// eigen kopie in domain.js, zodat de kleur meteen verandert en server.py
// blijft werken. Lopen die twee uiteen, dan toont de app iets anders dan wat
// er opgeslagen wordt.
//
// supabase/controle.sql houdt één tabel van gevallen, tussen de regels
// "-- regels:begin" en "-- regels:end": een ziekenhuis zoals het opgeslagen
// stond, zoals het binnenkomt, het bereik, en wat er na de opslag hoort te
// staan. Daar legt de databank ze langs haar eigen regels; hier leggen we
// dezelfde gevallen langs domain.js, zoals de app ze toepast.
//
// Wat dit bewijst: dat beide kanten dezelfde regel toepassen. Niet dat de
// browser van een beperkte gebruiker exact hetzelfde voorbeeld toont — die
// ziet maar een deel van het ziekenhuis, en dat bootsen we hier slechts na.
import assert from "node:assert/strict";
import { browserbestand, geval, klaar, lees } from "./laad.mjs";

// myProducts() leest het bereik bij elke oproep van window.FollowUpStore.
const win = {};
const D = browserbestand("public/domain.js", win).FollowUpDomain;
const kopie = (x) => JSON.parse(JSON.stringify(x));

// --- de gevallen uit controle.sql -------------------------------------------
const controle = lees("supabase/controle.sql");
const begin = controle.indexOf("\n-- regels:begin\n");
const eind = controle.indexOf("\n-- regels:end\n");
assert.ok(begin > 0 && eind > begin, "controle.sql: de merktekens regels:begin en regels:end ontbreken");
// (nr, 'naam', 's', 'h', 'bereik', 'modus', 'verwacht') — één geval per regel.
const REGEL = /^\s*\((\d+), '([^']*)', '([^']*)', '([^']*)', '([^']*)', '(save|import)', '([^']*)'\),?$/;
const gevallen = [];
let enkelSql = 0;
for (const regel of controle.slice(begin, eind).split("\n").slice(2)) {
  if (!regel.trim() || regel.trim().startsWith("--")) continue;
  const m = regel.match(REGEL);
  assert.ok(m, `controle.sql: deze regel is geen geval: ${regel.slice(0, 80)}`);
  if (m[2].startsWith("[sql] ")) { enkelSql++; continue; }
  gevallen.push({
    nr: +m[1], naam: m[2], s: JSON.parse(m[3]), h: JSON.parse(m[4]),
    bereik: JSON.parse(m[5]), modus: m[6], verwacht: JSON.parse(m[7]),
  });
}
assert.ok(gevallen.length >= 20, `controle.sql: maar ${gevallen.length} gevallen gevonden`);
// Elk geval is een controle in deel A, onder zijn eigen nummer: dat nummer
// mag niet twee keer voorkomen, en niet botsen met een andere controle.
await geval("nummers van de gevallen", () => {
  const nrs = [...controle.slice(begin, eind).matchAll(/^\s*\((\d+), '/gm)].map((m) => +m[1]);
  assert.equal(new Set(nrs).size, nrs.length, "een nummer staat twee keer in de tabel");
  const deelA = controle.slice(0, controle.indexOf("DEEL B"));
  const andere = [...deelA.matchAll(/^\s*(?:union all )?select (\d+),/gm)].map((m) => +m[1]);
  const botsing = nrs.filter((n) => andere.includes(n));
  assert.deepEqual(botsing, [], "een geval heeft het nummer van een andere controle");
});

// --- de app ------------------------------------------------------------------
// Zoals de app het doet, vanaf wat er opgeslagen stond: de rijen aanvullen
// (syncPipeline), elk nieuw moment en elk moment met een andere soort door
// autoStatus, en elk veranderd moment door syncRooms. De kamers vertrekken
// van het opgeslagen getal; doet geen enkel moment er iets aan, dan blijft
// het getal staan dat binnenkwam — dat is een getal dat iemand met de hand zette.
// De producten van een moment staan in een lijst. Een geval in de oude vorm
// ("product" met één naam) zet de databank om bij het lezen en bij het
// bewaren (lijstvorm in schema.sql), en normalize() in app.js doet hetzelfde;
// hier dus ook, aan beide kanten. Een lijst met meer dan één product draagt
// geen aantal.
const lijstvorm = (a0) => {
  const a = D.toProductList({ ...a0 });
  if (a.products.length > 1) { delete a.rooms; delete a.family; }
  return a;
};
function viaApp(s, h0, bereik, modus) {
  if (modus === "import") return kopie(h0);
  win.FollowUpStore = { can: { products: bereik } };
  const h = kopie(h0);
  h.products ||= [];
  h.activities = (h.activities || []).map(lijstvorm);
  h.unit ||= {};
  // Het opgeslagen ziekenhuis zoals de app het na het laden heeft
  // (normalizeActivity in app.js): een onbekende soort wordt "other", kamers
  // als tekst worden een getal, en een moment zonder id krijgt er een — het id
  // dat we in de payload terugzien bij hetzelfde moment.
  const datum = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? v : "");
  const geladen = (s.activities || []).map((a0) => {
    const a = lijstvorm(a0);
    if (!D.ACT_TYPE_KEYS.includes(a.type)) a.type = "other";
    a.date = datum(a.date);
    if (typeof a.rooms === "string" && a.rooms.trim() !== "" && !Number.isNaN(Number(a.rooms))) a.rooms = Number(a.rooms);
    // Een moment over meer producten draagt geen aantal (shared() in domain.js).
    if (D.shared(a)) a.rooms = null;
    if (!a.id) {
      const zelfde = h.activities.find((b) => b.type === a.type && datum(b.date) === a.date
        && JSON.stringify(D.productsOf(b)) === JSON.stringify(D.productsOf(a)));
      if (zelfde) a.id = zelfde.id;
    }
    return a;
  });
  const oud = new Map(geladen.map((a) => [a.id, a]));
  const nieuw = new Map(h.activities.map((a) => [a.id, a]));

  D.syncPipeline(h);
  for (const a of h.activities) {
    if (!a.id) continue;
    if (oud.has(a.id) && oud.get(a.id).type === a.type) continue;
    // Een beperkte browser ziet van een moment over meer producten enkel de
    // zijne (scope_entries in schema.sql): de rij van de collega kan hij niet
    // verzetten. Dat bootsen we na door het moment te snoeien zoals de
    // databank het hem zou sturen.
    // Een moment enkel over producten buiten het bereik krijgt hij niet te zien.
    const zijne = D.productsOf(a).filter((p) => bereik.includes(p));
    if (bereik.length && D.productsOf(a).length && !zijne.length) continue;
    D.autoStatus(h, bereik.length ? { ...a, products: zijne } : a);
  }

  const start = s.unit?.roomsInstalled == null ? null : Number(s.unit.roomsInstalled);
  const kamers = { unit: { roomsInstalled: start }, activities: h.activities };
  for (const id of new Set([...oud.keys(), ...nieuw.keys()])) {
    const voor = oud.get(id) ?? null, na = nieuw.get(id) ?? null;
    if (JSON.stringify(voor) !== JSON.stringify(na)) D.syncRooms(kamers, voor, na);
  }
  if (kamers.unit.roomsInstalled !== start) h.unit.roomsInstalled = kamers.unit.roomsInstalled;
  return h;
}

// Wat de gevallen vergelijken, net als regelzicht in controle.sql. Van een
// rij enkel fase, kleur en verantwoordelijke: de app zet er voor een product
// per ingreep nog lege gegevensvelden bij (normalizeFacts), en die gaan de
// databank niet aan.
const zicht = (h) => ({
  pipeline: Object.fromEntries(Object.entries(h.pipeline || {})
    .map(([p, e]) => [p, { stage: e.stage, status: e.status, owner: e.owner }])),
  status: h.status ?? null,
  stage: h.stage ?? null,
  roomsInstalled: h.unit?.roomsInstalled ?? null,
});

// --- de omzetting naar een lijst ---------------------------------------------
// controle.sql houdt een document met elke oude vorm (oudvorm) en wat
// followup.lijstvorm() ervan hoort te maken (oudvormverwacht). Dezelfde
// records gaan hier door toProductList(), de omzetting van normalize() in
// app.js. Enkel de producten worden vergeleken: het aantal en "shared" regelt
// normalize() elk apart, de databank in zonder_aantal().
const jsonNa = (naam) => {
  const i = controle.indexOf(`\n${naam} as (select $j$`);
  assert.ok(i > 0, `controle.sql: ${naam} niet gevonden`);
  const van = controle.indexOf("$j$", i) + 3;
  return JSON.parse(controle.slice(van, controle.indexOf("$j$", van)));
};
await geval("toProductList zet elke oude vorm om zoals followup.lijstvorm()", () => {
  const records = (doc) => doc.hospitals.flatMap((h) => ["contacts", "activities", "planned"]
    .flatMap((k) => (h[k] || []).map((r) => [`${h.id}/${k}/${r.id}`, r])));
  const voor = records(jsonNa("oudvorm"));
  const na = Object.fromEntries(records(jsonNa("oudvormverwacht")));
  assert.ok(voor.length >= 10, `maar ${voor.length} records in oudvorm`);
  for (const [sleutel, r] of voor) {
    const uit = D.toProductList(kopie(r));
    assert.deepEqual(uit.products, na[sleutel].products, sleutel);
    assert.ok(!("product" in uit), `${sleutel}: "product" bleef staan`);
  }
});

for (const g of gevallen) {
  await geval(`${g.nr} ${g.naam}`, () => {
    const uit = viaApp(g.s, g.h, g.bereik, g.modus);
    assert.deepEqual(zicht(uit), g.verwacht);
    // Wat de browser al deed, nog een keer: verandert niets.
    if (g.modus === "save") assert.deepEqual(zicht(viaApp(g.s, uit, g.bereik, g.modus)), g.verwacht, "een tweede keer veranderde iets");
  });
}

klaar("databank", `${gevallen.length} gevallen uit controle.sql, ${enkelSql} enkel voor de databank`);
