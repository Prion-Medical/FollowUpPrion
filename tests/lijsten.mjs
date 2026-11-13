// De vaste lijsten staan op meer dan één plaats: in domain.js voor de app, in
// de koppeling voor een assistent, in schema.sql voor de databank en in de
// agendafunctie voor de namen van de soorten. Deze controle kijkt of ze nog
// overeenkomen. Een verschil hier is een fout die anders pas opvalt in het
// ene kanaal dat niemand testte.
import assert from "node:assert/strict";
import { domein, geval, klaar, lees, letterlijk, vertalingen } from "./laad.mjs";

const D = domein();
const agent = lees("supabase/functions/agent/index.ts");
const agenda = lees("supabase/functions/calendar/index.ts");
const dom = lees("public/domain.js");
const schema = lees("supabase/schema.sql");
const sqlLijst = (functie) => {
  const treffers = [...schema.matchAll(new RegExp(`function followup\\.${functie}\\(\\)[^$]*\\$\\$\\s*select array\\[([^\\]]*)\\]`, "g"))];
  assert.equal(treffers.length, 1, `followup.${functie}() hoort één keer in schema.sql te staan`);
  return [...treffers[0][1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
};

// --- producten -------------------------------------------------------------
await geval("producten", () => {
  assert.deepEqual(letterlijk(agent, "PRODUCTS"), D.PRODUCTS, "koppeling ≠ domain.js");
  assert.deepEqual(sqlLijst("producten"), D.PRODUCTS, "followup.producten() ≠ domain.js");
  assert.deepEqual(letterlijk(agent, "PROCEDURE"), D.PRODUCTS.filter((p) => D.productKind(p) === "procedure"),
    "producten per stuk: koppeling ≠ productKind() in domain.js");
});

// --- fases -----------------------------------------------------------------
await geval("fases", () => {
  assert.deepEqual(letterlijk(agent, "STAGES"), D.STAGES, "koppeling ≠ domain.js");
  assert.deepEqual(sqlLijst("fases"), D.STAGES, "followup.fases() ≠ domain.js");
});

// --- soorten contactmoment -------------------------------------------------
const soorten = Object.keys(D.ACT_TYPES);
await geval("soorten", () => {
  // De koppeling houdt twee lijsten: alles wat bestaat (KNOWN_TYPES =
  // ["prospecting", ...ACT_TYPES], ook om op te zoeken) en wat nog gekozen
  // kan worden (ACT_TYPES). Dat KNOWN_TYPES zo opgebouwd is, kijken we na.
  assert.match(agent, /^const KNOWN_TYPES = \["prospecting", \.\.\.ACT_TYPES\];$/m, "KNOWN_TYPES is niet meer prospecting + ACT_TYPES");
  const gekend = ["prospecting", ...letterlijk(agent, "ACT_TYPES")];
  assert.deepEqual(gekend, soorten, "koppeling ≠ domain.js (ook de volgorde)");
  assert.ok(!letterlijk(agent, "ACT_TYPES").includes("prospecting"), "de koppeling biedt prospecting nog aan");
  assert.deepEqual(letterlijk(agent, "SOLD_TYPES"), D.SOLD_TYPES, "verkochte soorten: koppeling ≠ domain.js");
  assert.deepEqual(letterlijk(agent, "ROOM_TYPES"), D.ROOM_TYPES, "soorten met kamers: koppeling ≠ domain.js");
});
const namen = letterlijk(agenda, "TYPES");
const V = vertalingen();
for (const taal of ["nl", "en"]) {
  await geval(`namen van de soorten (${taal})`, () => {
    assert.deepEqual(Object.keys(namen[taal]).sort(), [...soorten].sort(), "de agendafunctie kent andere soorten");
    // Wat in een geabonneerde agenda staat, is wat de app toont.
    for (const k of soorten) {
      assert.ok(V[taal].has("act." + k), `vertaling act.${k} ontbreekt`);
      assert.equal(namen[taal][k], V.t(taal, "act." + k), `${k}: agendafunctie ≠ i18n.js`);
    }
  });
}

// --- soorten stent, en wat je per product bijhoudt --------------------------
await geval("soorten stent", () => {
  const families = letterlijk(agent, "FAMILIES");
  for (const p of D.PRODUCTS) assert.deepEqual(families[p] || [], D.familiesFor(p), `${p}: koppeling ≠ domain.js`);
});
await geval("gegevens per product", () => {
  // De gegevens zelf, in beide bestanden: hoe factsFor() ze gebruikt, legt
  // regels.mjs na langs de koppeling.
  assert.deepEqual(letterlijk(agent, "FACTS"), letterlijk(dom, "FACTS"), "FACTS: koppeling ≠ domain.js");
  assert.deepEqual(letterlijk(agent, "PRODUCT_FACTS"), letterlijk(dom, "PRODUCT_FACTS"), "PRODUCT_FACTS: koppeling ≠ domain.js");
});

// --- de andere vaste lijsten -------------------------------------------------
// Een nieuw land, een nieuwe dienst: het recept in CLAUDE.md noemt de
// koppeling niet altijd, dus hier staat het.
await geval("andere lijsten", () => {
  for (const [naam, waarde] of [["COUNTRIES", D.COUNTRIES], ["CMM_STATES", D.CMM_STATES], ["YES_NO", D.YES_NO],
    ["PRE_SALE", D.PRE_SALE], ["DEPARTMENTS", D.DEPARTMENTS], ["SECTORS", D.SECTORS], ["LANGUAGES", D.LANGUAGES]]) {
    assert.deepEqual(letterlijk(agent, naam), waarde, `${naam}: koppeling ≠ domain.js`);
  }
  assert.deepEqual(letterlijk(agent, "BRANDS"), D.SCOPE_BRANDS, "BRANDS (koppeling) ≠ SCOPE_BRANDS (domain.js)");
  assert.deepEqual(D.PROCESSOR_BRANDS, D.SCOPE_BRANDS, "de koppeling houdt één merkenlijst voor scopes én torens");
});

// --- werktuigen: wat verplicht is, mag niet "weglaten" zeggen -----------------
// add_planned_moment eiste een datum terwijl de uitleg zei dat je ze kon
// weglaten; een assistent die de uitleg volgt, kreeg een fout.
await geval("werktuigen: verplicht ≠ weglaten", () => {
  const blokken = agent.split(/\n  \{\n    name: "/).slice(1);
  assert.ok(blokken.length >= 10, "de werktuigen niet gevonden");
  for (const blok of blokken) {
    const naam = blok.slice(0, blok.indexOf('"'));
    const verplicht = (blok.match(/required: \[([^\]]*)\]/) || [, ""])[1].match(/"([^"]+)"/g)?.map((x) => x.slice(1, -1)) || [];
    for (const veld of verplicht) {
      const def = blok.match(new RegExp(`\\n\\s+${veld}: (\\{[^\\n]*\\}|[A-Z_]+),`));
      if (!def) continue;
      assert.ok(!/leave (it )?out/i.test(def[1]), `${naam}.${veld} is verplicht, maar de uitleg zegt dat het weg mag`);
    }
  }
});

klaar("lijsten");
