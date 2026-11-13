// Wat de koppeling voor een assistent nog zelf doet met een contactmoment, en
// wat ze sinds issue #21 aan de databank laat.
//
// De kleur, de fase per product en de geïnstalleerde kamers die een
// contactmoment teweegbrengt, beslist write_state() in de databank;
// tests/databank.mjs legt die regels naast domain.js. Deze controle kijkt de
// koppeling na op wat zij nog doet:
//
//  - het moment zelf: de vorm (één product of de lijstvorm), het aantal, de
//    soort stent, en welke soorten een keuze van producten toelaat — precies
//    wat de app bewaart en aanbiedt;
//  - het product aanvinken op het ziekenhuis, en verder de opvolging, de kleur,
//    de fase en de geïnstalleerde kamers níét aanraken;
//  - stageStatus() en zonderProduct(), die niet over een contactmoment gaan en
//    dus in de koppeling blijven, tegen domain.js;
//  - het antwoord: dat meldt wat read_state na de opslag teruggaf, niet wat de
//    koppeling zelf schreef. Daarom doet de nagebootste databank hier bij het
//    opslaan iets dat de koppeling niet deed (een rij verzetten), en moet dat
//    in het antwoord staan.
import assert from "node:assert/strict";
import { domein, geval, klaar, koppeling } from "./laad.mjs";

const D = domein();
const K = await koppeling();
const kopie = (x) => JSON.parse(JSON.stringify(x));

// --- de nagebootste databank -------------------------------------------------
// laad.mjs leest K.stand bij read_state en zet het bij write_state. Hier wordt
// dat een eigenschap met een getter en een setter, zodat deze controle ziet
// wat de koppeling schreef (geschreven) los van wat er daarna opgeslagen staat
// (wat databank() ervan maakt). leesFout: read_state faalt na de opslag.
let opgeslagen = { version: 1, hospitals: [] };
let geschreven = null;
let databank = null;
let leesFout = false;
Object.defineProperty(K, "stand", {
  get() {
    if (leesFout && geschreven) throw new Error("read_state faalt");
    return opgeslagen;
  },
  set(v) {
    geschreven = kopie(v);
    opgeslagen = databank ? databank(kopie(v)) : v;
  },
});
function begin(zhs, scope = [], { na = null, faalt = false } = {}) {
  opgeslagen = { version: 1, hospitals: (Array.isArray(zhs) ? zhs : [zhs]).map(kopie) };
  geschreven = null;
  databank = na;
  leesFout = faalt;
  K.scope = scope;
}
async function roep(naam, args) {
  const r = await K.werktuig(naam, args);
  assert.ok(!r.fout, `de koppeling weigerde: ${r.tekst}`);
  assert.ok(geschreven, "er werd niets geschreven");
  return { uit: r.uit, h: geschreven.hospitals[0] };
}

// --- de app ------------------------------------------------------------------
// Zoals activityDialog() een nieuw contactmoment bewaart: het record en het
// vinkje. Wat daarna volgt (syncPipeline, autoStatus, syncRooms) is niet meer
// aan de koppeling.
function nieuwViaApp(zh, moment) {
  const h = kopie(zh);
  const rec = { id: "nieuw", date: "2026-10-01", type: moment.type, note: "", contactId: "" };
  if (moment.products.length > 1) rec.products = moment.products; else rec.product = moment.products[0] || "";
  rec.rooms = !D.shared(rec) && D.wantsQuantity(moment.type, D.productOf(rec)) ? moment.rooms ?? null : null;
  if (moment.family && D.wantsFamily(moment.type, D.productOf(rec))) rec.family = moment.family;
  h.activities.push(rec);
  for (const p of D.productsOf(rec)) if (!h.products.includes(p)) h.products.push(p);
  return h;
}
// Zoals activityDialog() een bestaand contactmoment aanpast, wat het record betreft.
function wijzigViaApp(zh, id, wijziging) {
  const h = kopie(zh);
  const rec = h.activities.find((a) => a.id === id);
  Object.assign(rec, wijziging);
  if (!D.wantsQuantity(rec.type, D.productOf(rec))) rec.rooms = null;
  return h;
}

// Het moment en de vinkjes: wat de koppeling moet schrijven zoals de app.
const record = (h, id) => {
  const a = id ? h.activities.find((x) => x.id === id) : h.activities[h.activities.length - 1];
  return {
    products: [...h.products],
    moment: a && { type: a.type, products: D.productsOf(a), lijst: D.shared(a), rooms: a.rooms ?? null, family: a.family || "" },
  };
};
// Wat de databank beslist en de koppeling dus moet laten zoals het was.
const opvolging = (h) => ({ pipeline: h.pipeline ?? null, status: h.status, stage: h.stage, roomsInstalled: h.unit?.roomsInstalled ?? null });
const onaangeroerd = (geschreven, start) =>
  assert.deepEqual(opvolging(geschreven), opvolging(start), "de koppeling raakte de opvolging, de kleur, de fase of de kamers aan");

// --- de gevallen ---------------------------------------------------------------
const zh = (extra = {}) => ({ id: "h", name: "AZ Proef", country: "BE", status: "red", stage: "prospect",
  products: [], contacts: [], activities: [], planned: [], unit: {}, ...extra });
const rij = (stage, status) => ({ stage, status, owner: "" });
const NIEUW = [
  ["eerste telefoon voor een nieuw product", zh(), { type: "call", products: ["Thyroid RFA"] }],
  ["e-mail zonder product, ziekenhuis zonder product", zh(), { type: "email", products: [] }],
  ["procedure met stents bij een prospect", zh(), { type: "procedure", products: ["Stents"], rooms: 2 }],
  ["procedure met stents en een soort", zh(), { type: "procedure", products: ["Stents"], rooms: 4, family: "biliary" }],
  ["bestelling stents met een soort", zh(), { type: "order", products: ["Stents"], rooms: 10, family: "colonic" }],
  ["demo EndoQ met twee kamers", zh(), { type: "demo", products: ["EndoQ"], rooms: 2 }],
  ["installatie EndoQ, drie kamers", zh(), { type: "installation", products: ["EndoQ"], rooms: 3 }],
  ["stopzetting van één kamer bij een klant",
    zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") }, unit: { roomsInstalled: 3 } }),
    { type: "cancellation", products: ["EndoQ"], rooms: 1 }],
  ["bestelling bij een product in de wacht",
    zh({ products: ["Fibroid RFA"], status: "orange", stage: "on_hold", pipeline: { "Fibroid RFA": rij("on_hold", "orange") } }),
    { type: "order", products: ["Fibroid RFA"], rooms: 5 }],
  ["bezoek zonder product bij twee producten",
    zh({ products: ["Thyroid RFA", "Fibroid RFA"], status: "orange", stage: "meeting",
      pipeline: { "Thyroid RFA": rij("meeting", "orange"), "Fibroid RFA": rij("prospect", "red") } }),
    { type: "visit", products: [] }],
  ["één bezoek over twee producten",
    zh({ products: ["Thyroid RFA", "Fibroid RFA"], status: "orange", stage: "meeting",
      pipeline: { "Thyroid RFA": rij("meeting", "orange"), "Fibroid RFA": rij("prospect", "red") } }),
    { type: "visit", products: ["Thyroid RFA", "Fibroid RFA"] }],
  ["demo bij wie niet geïnteresseerd was",
    zh({ products: ["EndoQ"], status: "red", stage: "not_interested", pipeline: { EndoQ: rij("not_interested", "red") } }),
    { type: "demo", products: ["EndoQ"], rooms: 1 }],
  ["procedure bij een klant",
    zh({ products: ["Thyroid RFA"], status: "green", stage: "customer", pipeline: { "Thyroid RFA": rij("customer", "green") } }),
    { type: "procedure", products: ["Thyroid RFA"], rooms: 3 }],
  ["bestelling voor een abonnementsproduct",
    zh({ products: ["Ainex"], status: "orange", stage: "first_contact", pipeline: { Ainex: rij("first_contact", "orange") } }),
    { type: "order", products: ["Ainex"], rooms: 2 }],
  ["tweede product bij een ziekenhuis dat er al een heeft",
    zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") }, unit: { roomsInstalled: 2 } }),
    { type: "call", products: ["Stents"] }],
];
const argsVoor = (moment) => {
  const args = { hospital_id: "h", type: moment.type, date: "2026-10-01" };
  if (moment.products.length > 1) args.products = moment.products;
  else if (moment.products.length) args.product = moment.products[0];
  if (moment.rooms != null) args.quantity = moment.rooms;
  if (moment.family) args.family = moment.family;
  return args;
};
for (const [naam, start, moment] of NIEUW) {
  await geval(`nieuw: ${naam}`, async () => {
    begin(start);
    const { h } = await roep("add_contact_moment", argsVoor(moment));
    assert.deepEqual(record(h), record(nieuwViaApp(start, moment)), "het moment of het vinkje verschilt van de app");
    onaangeroerd(h, start);
  });
}

// Een moment aanpassen: het record zoals de app het aanpast; de opvolging en
// de kamers volgen in de databank.
const geinstalleerd = zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") },
  unit: { roomsInstalled: 3 },
  activities: [{ id: "i1", date: "2026-09-01", type: "installation", product: "EndoQ", rooms: 3, note: "", contactId: "" }] });
const gesprek = zh({ products: ["EndoQ"], status: "orange", stage: "meeting", pipeline: { EndoQ: rij("meeting", "orange") },
  activities: [{ id: "c1", date: "2026-09-01", type: "call", product: "EndoQ", rooms: null, note: "", contactId: "" }] });
const AANPASSEN = [
  ["installatie van 3 naar 5 kamers", geinstalleerd, "i1", { rooms: 5 }, { quantity: 5 }],
  ["installatie wordt een stopzetting", geinstalleerd, "i1", { type: "cancellation" }, { type: "cancellation" }],
  ["een gesprek wordt een installatie", gesprek, "c1", { type: "installation", rooms: 2 }, { type: "installation", quantity: 2 }],
  ["een gesprek wordt een gesprek over Ainex", gesprek, "c1", { product: "Ainex" }, { product: "Ainex" }],
];
for (const [naam, start, id, app, args] of AANPASSEN) {
  await geval(`aanpassen: ${naam}`, async () => {
    begin(start);
    const { h } = await roep("update_moment", { kind: "contact_moment", hospital_id: "h", record_id: id, ...args });
    const verwacht = wijzigViaApp(start, id, app);
    for (const p of D.productsOf(verwacht.activities.find((a) => a.id === id))) if (!verwacht.products.includes(p)) verwacht.products.push(p);
    assert.deepEqual(record(h, id), record(verwacht, id), "het moment of het vinkje verschilt van de app");
    onaangeroerd(h, start);
  });
}

// Afvinken, een contactpersoon met een product, een installatie verwijderen:
// ook daar blijven de opvolging en de kamers aan de databank.
const metPlan = zh({ products: ["EndoQ"], status: "orange", stage: "demo_installed", pipeline: { EndoQ: rij("demo_installed", "orange") },
  unit: { roomsInstalled: null },
  planned: [{ id: "p1", date: "2026-09-20", type: "installation", product: "EndoQ", note: "", contactId: "" }] });
await geval("afvinken: een geplande installatie", async () => {
  begin(metPlan);
  const { h } = await roep("complete_planned_moment", { hospital_id: "h", planned_id: "p1", quantity: 2, date: "2026-09-20" });
  const a = h.activities.find((x) => x.id === "p1");
  assert.deepEqual({ type: a.type, product: a.product, rooms: a.rooms }, { type: "installation", product: "EndoQ", rooms: 2 });
  assert.equal(h.planned.length, 0, "het plan staat er nog");
  onaangeroerd(h, metPlan);
});
await geval("contactpersoon met een nieuw product: aangevinkt, geen rij", async () => {
  const start = zh({ products: ["EndoQ"], status: "orange", stage: "meeting", pipeline: { EndoQ: rij("meeting", "orange") } });
  begin(start);
  const { h } = await roep("add_contact", { hospital_id: "h", name: "Dr. Proef", products: ["Thyroid RFA"] });
  assert.deepEqual(h.products, ["EndoQ", "Thyroid RFA"]);
  onaangeroerd(h, start);
});
await geval("verwijderen: een installatie haalt zelf geen kamers af", async () => {
  begin(geinstalleerd);
  const eerst = await K.werktuig("remove", { kind: "contact_moment", hospital_id: "h", record_id: "i1" });
  assert.ok(!eerst.fout && eerst.uit.confirm, eerst.tekst);
  assert.equal(geschreven, null, "de eerste stap schreef al");
  const { h } = await roep("remove", { kind: "contact_moment", hospital_id: "h", record_id: "i1", confirm: eerst.uit.confirm });
  assert.equal(h.activities.length, 0, "het moment staat er nog");
  onaangeroerd(h, geinstalleerd);
});

// --- het antwoord komt uit wat er opgeslagen is ----------------------------------
// De nagebootste databank verzet bij het opslaan een rij en de kleur van het
// ziekenhuis, zoals write_state() dat doet. De koppeling schreef dat niet;
// staat het in het antwoord, dan las ze het terug.
const verzet = (fase, kleur, producten = null) => (doc) => {
  const h = doc.hospitals[0];
  h.pipeline = h.pipeline || {};
  for (const p of producten || h.products) h.pipeline[p] = rij(fase, kleur);
  h.status = kleur; h.stage = fase;
  return doc;
};
await geval("antwoord: één product, zoals opgeslagen", async () => {
  begin(gesprek, [], { na: verzet("customer", "green") });
  const { uit } = await roep("add_contact_moment", { hospital_id: "h", type: "order", product: "EndoQ", quantity: 1 });
  assert.deepEqual(uit.follow_up, { product: "EndoQ", stage: "customer", status: "green" });
  assert.equal(uit.changed_hospital_status, true);
});
await geval("antwoord: niets verzet, dan ook niets veranderd", async () => {
  begin(gesprek);
  const { uit } = await roep("add_contact_moment", { hospital_id: "h", type: "call", product: "EndoQ" });
  assert.deepEqual(uit.follow_up, { product: "EndoQ", stage: "meeting", status: "orange" });
  assert.equal(uit.changed_hospital_status, false);
});
await geval("antwoord: een nieuw product krijgt zijn rij van de databank", async () => {
  begin(zh(), [], { na: verzet("first_contact", "orange") });
  const { uit, h } = await roep("add_contact_moment", { hospital_id: "h", type: "call", product: "Stents" });
  assert.equal(h.pipeline, undefined, "de koppeling maakte zelf een rij");
  assert.deepEqual(uit.follow_up, { product: "Stents", stage: "first_contact", status: "orange" });
});
await geval("antwoord: twee producten, elk zoals opgeslagen", async () => {
  const start = NIEUW.find(([n]) => n === "één bezoek over twee producten")[1];
  begin(start, [], { na: verzet("evaluation", "orange") });
  const { uit } = await roep("add_contact_moment", { hospital_id: "h", type: "visit", products: ["Thyroid RFA", "Fibroid RFA"] });
  assert.deepEqual(uit.follow_up, [
    { product: "Thyroid RFA", stage: "evaluation", status: "orange" },
    { product: "Fibroid RFA", stage: "evaluation", status: "orange" },
  ]);
});
await geval("antwoord: zonder product, het ziekenhuis zoals opgeslagen", async () => {
  begin(zh(), [], { na: (doc) => { Object.assign(doc.hospitals[0], { status: "orange", stage: "first_contact" }); return doc; } });
  const { uit } = await roep("add_contact_moment", { hospital_id: "h", type: "email" });
  assert.deepEqual(uit.follow_up, { stage: "first_contact", status: "orange" });
  assert.equal(uit.changed_hospital_status, true);
});
await geval("antwoord: afvinken, zoals opgeslagen", async () => {
  begin(metPlan, [], { na: verzet("customer", "green") });
  const { uit } = await roep("complete_planned_moment", { hospital_id: "h", planned_id: "p1", quantity: 2 });
  assert.deepEqual(uit.follow_up, { product: "EndoQ", stage: "customer", status: "green" });
});
await geval("antwoord: een aangepast moment, zoals opgeslagen", async () => {
  begin(gesprek, [], { na: verzet("customer", "green") });
  const { uit } = await roep("update_moment", { kind: "contact_moment", hospital_id: "h", record_id: "c1", type: "order", quantity: 1 });
  assert.deepEqual(uit.follow_up, { product: "EndoQ", stage: "customer", status: "green" });
});
await geval("antwoord: update_follow_up, zoals opgeslagen", async () => {
  begin(gesprek, [], { na: verzet("purchasing", "orange") });
  const { uit, h } = await roep("update_follow_up", { hospital_id: "h", product: "EndoQ", stage: "evaluation" });
  assert.equal(h.pipeline.EndoQ.stage, "evaluation", "geschreven werd iets anders dan gevraagd");
  assert.deepEqual(uit.follow_up, { stage: "purchasing", status: "orange" });
});
await geval("antwoord: niet meer volgen, het ziekenhuis zoals opgeslagen", async () => {
  begin(gesprek, [], { na: (doc) => { Object.assign(doc.hospitals[0], { status: "red", stage: "on_hold" }); return doc; } });
  const { uit } = await roep("update_follow_up", { hospital_id: "h", product: "EndoQ", followed: false });
  assert.deepEqual(uit.hospital_status, { stage: "on_hold", status: "red" });
});
await geval("antwoord: alleen de fase verzet, ook dat is veranderd", async () => {
  begin(gesprek, [], { na: verzet("evaluation", "orange") });
  const { uit } = await roep("add_contact_moment", { hospital_id: "h", type: "call", product: "EndoQ" });
  assert.equal(uit.changed_hospital_status, true, "een andere fase met dezelfde kleur telt niet als verandering");
});
await geval("antwoord: vreemde vormen in wat teruggelezen werd, en toch opgeslagen", async () => {
  // Een fout bij het maken van het antwoord na een geslaagde opslag mag niet
  // als mislukte opslag terugkomen: de assistent zou het moment herhalen.
  // rowOf() en storedHospital() vangen elke JSON-vorm op; de catch rond
  // after() in change() is het vangnet daarachter.
  begin(gesprek, [], { na: (doc) => { doc.hospitals[0].pipeline = { EndoQ: null }; doc.hospitals.unshift(null); return doc; } });
  const r = await K.werktuig("add_contact_moment", { hospital_id: "h", type: "call", product: "EndoQ" });
  assert.ok(!r.fout, `gemeld als fout, terwijl er opgeslagen is: ${r.tekst}`);
  assert.equal(r.uit.saved, true);
});
await geval("antwoord: teruglezen mislukt, en toch opgeslagen", async () => {
  begin(gesprek, [], { faalt: true });
  const r = await K.werktuig("add_contact_moment", { hospital_id: "h", type: "call", product: "EndoQ" });
  assert.ok(!r.fout, `gemeld als fout, terwijl er opgeslagen is: ${r.tekst}`);
  assert.equal(r.uit.saved, true);
  assert.match(String(r.uit.follow_up), /could not be read back/);
  assert.ok(r.uit.contact_moment && !r.uit.reply && !r.uit.rec, "het antwoord heeft niet de gewone vorm");
  assert.equal(geschreven.hospitals[0].activities.length, 2, "het moment werd niet geschreven");
});

// --- wat de koppeling zelf nog beslist ------------------------------------------
// stageStatus(): een fase met de hand gekozen bepaalt mee de kleur. Elke fase
// die een product kent, vanuit elke kleur, met en zonder contactmoment.
const KLEUREN = ["red", "orange", "green"];
for (const product of ["EndoQ", "Thyroid RFA"]) {
  await geval(`stageStatus voor ${product}`, async () => {
    const mis = [];
    for (const fase of D.stagesFor(product)) for (const kleur of KLEUREN) for (const gesproken of [false, true]) {
      const start = zh({ products: [product], status: kleur, stage: "meeting", pipeline: { [product]: rij("meeting", kleur) },
        activities: gesproken ? [{ id: "a", date: "2026-09-01", type: "call", product, note: "", contactId: "" }] : [] });
      begin(start);
      const { h } = await roep("update_follow_up", { hospital_id: "h", product, stage: fase });
      const app = rij(fase, kleur);
      D.stageStatus(app, gesproken);
      if (h.pipeline[product].status !== app.status) mis.push(`${fase} vanuit ${kleur}${gesproken ? ", gesproken" : ""}: koppeling ${h.pipeline[product].status}, app ${app.status}`);
    }
    assert.deepEqual(mis, [], "verschil");
  });
}
await geval("stageStatus voor een ziekenhuis zonder product", async () => {
  const mis = [];
  for (const fase of D.stagesFor("")) for (const kleur of KLEUREN) for (const gesproken of [false, true]) {
    const start = zh({ status: kleur, stage: "meeting",
      activities: gesproken ? [{ id: "a", date: "2026-09-01", type: "call", product: "", note: "", contactId: "" }] : [] });
    begin(start);
    const { h } = await roep("update_hospital", { hospital_id: "h", stage: fase });
    const app = { stage: fase, status: kleur };
    D.stageStatus(app, gesproken);
    if (h.status !== app.status) mis.push(`${fase} vanuit ${kleur}${gesproken ? ", gesproken" : ""}: koppeling ${h.status}, app ${app.status}`);
  }
  assert.deepEqual(mis, [], "verschil");
});

// zonderProduct(): het laatste vinkje weg, dan terug naar wat de
// contactmomenten zeggen. Met een tweede product blijft het ziekenhuis zoals
// het was; dat het verst staande product het overneemt, doet de databank.
const TWEE = zh({ products: ["EndoQ", "Ainex"], status: "green", stage: "customer",
  pipeline: { EndoQ: rij("customer", "green"), Ainex: rij("meeting", "orange") } });
const VINKJES = [
  ["laatste product, nooit gesproken", zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") } }), "EndoQ"],
  ["laatste product, wel gesproken", geinstalleerd, "EndoQ"],
  ["een van twee producten", TWEE, "EndoQ"],
];
for (const [naam, start, product] of VINKJES) {
  await geval(`niet meer volgen: ${naam}`, async () => {
    begin(start);
    const { h } = await roep("update_follow_up", { hospital_id: "h", product, followed: false });
    const app = kopie(start);
    app.products = app.products.filter((p) => p !== product);
    D.zonderProduct(app);
    assert.deepEqual({ products: h.products, status: h.status, stage: h.stage, pipeline: h.pipeline },
      { products: app.products, status: app.status, stage: app.stage, pipeline: app.pipeline });
  });
}

// Een product dat hier nog niet gevolgd werd, met de hand gaan volgen: de
// koppeling maakt de rij zelf (newRow()), want wat met de hand gezet wordt
// moet erop landen. Zoals syncPipeline() ze maakt.
const RIJEN = [
  ["eerste product erft van het ziekenhuis", zh({ status: "orange", stage: "meeting" }), "EndoQ"],
  ["eerste product, een fase die het niet kent", zh({ status: "orange", stage: "purchasing" }), "Ainex"],
  ["tweede product, niet gesproken", zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") } }), "Stents"],
  ["tweede product, al gesproken", zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") },
    activities: [{ id: "a", date: "2026-09-01", type: "call", product: "Stents", note: "", contactId: "" }] }), "Stents"],
];
for (const [naam, start, product] of RIJEN) {
  await geval(`gaan volgen: ${naam}`, async () => {
    begin(start);
    const { h } = await roep("update_follow_up", { hospital_id: "h", product });
    const app = kopie(start);
    app.products.push(product);
    D.syncPipeline(app);
    const kort = (e) => e && { stage: e.stage, status: e.status, owner: e.owner };
    assert.deepEqual(kort(h.pipeline[product]), kort(app.pipeline[product]));
  });
}

// --- welke soorten een keuze van producten toelaat ---------------------------
// De app biedt typesAmong(producten, bereik, gedeeld) aan; de koppeling moet
// precies die aanvaarden en de rest weigeren. Voor geen product, één, twee,
// en voor een account dat maar één product mag.
const soorten = Object.keys(D.ACT_TYPES).filter((k) => k !== "prospecting");
const KEUZES = [
  ...D.PRODUCTS.map((p) => [[p], []]),
  [[], []],
  [[], ["EndoQ"]],
  [[], ["Stents"]],
  [["Thyroid RFA", "Fibroid RFA"], []],
  [["EndoQ", "Thyroid RFA"], []],
];
for (const [lijst, bereik] of KEUZES) {
  await geval(`soorten bij [${lijst.join(", ")}]${bereik.length ? ` voor ${bereik.join(", ")}` : ""}`, async () => {
    const mis = [];
    for (const soort of soorten) {
      begin(zh(), bereik);
      const args = { hospital_id: "h", type: soort, date: "2026-10-01" };
      if (lijst.length > 1) args.products = lijst; else if (lijst.length) args.product = lijst[0];
      const r = await K.werktuig("add_contact_moment", args);
      const app = D.typesAmong(lijst, bereik.length ? bereik : D.PRODUCTS).includes(soort);
      if (app === r.fout) mis.push(`${soort}: app ${app ? "biedt aan" : "biedt niet aan"}, koppeling ${r.fout ? "weigert" : "aanvaardt"}`);
    }
    assert.deepEqual(mis, [], "verschil");
  });
}

// Een gedeeld moment (lijstvorm) zoals een account met één product het ziet:
// de lijst is ingekort tot dat ene product. Het draagt toch geen aantal.
const gedeeld = zh({ products: ["Thyroid RFA"], status: "orange", stage: "meeting", pipeline: { "Thyroid RFA": rij("meeting", "orange") },
  activities: [{ id: "g1", date: "2026-09-01", type: "visit", products: ["Thyroid RFA"], note: "", contactId: "" }],
  planned: [{ id: "gp1", date: "2026-09-20", type: "visit", products: ["Thyroid RFA"], note: "", contactId: "" }] });
await geval("gedeeld moment: soorten met een aantal vallen weg", () => {
  const app = D.typesAmong(["Thyroid RFA"], ["Thyroid RFA"], true);
  assert.ok(!app.includes("order") && !app.includes("procedure") && app.includes("visit"), `typesAmong gaf ${app}`);
});
await geval("gedeeld moment: de koppeling maakt er geen bestelling van", async () => {
  begin(gedeeld, ["Thyroid RFA"]);
  const r = await K.werktuig("update_moment", { kind: "contact_moment", hospital_id: "h", record_id: "g1", type: "order", quantity: 5 });
  assert.ok(r.fout, "aanvaard: " + r.tekst);
});
await geval("gedeeld plan: afvinken met een aantal wordt geweigerd", async () => {
  begin(gedeeld, ["Thyroid RFA"]);
  const r = await K.werktuig("complete_planned_moment", { hospital_id: "h", planned_id: "gp1", quantity: 3 });
  assert.ok(r.fout, "aanvaard: " + r.tekst);
});
await geval("gedeeld plan: afvinken houdt de lijstvorm", async () => {
  begin(gedeeld, ["Thyroid RFA"]);
  const { h } = await roep("complete_planned_moment", { hospital_id: "h", planned_id: "gp1", date: "2026-09-20" });
  const a = h.activities.find((x) => x.id === "gp1");
  assert.ok(D.shared(a), "het contactmoment staat niet meer in de lijstvorm");
  onaangeroerd(h, gedeeld);
});

// Een nieuw moment of een plan over meer producten mag elke soort die al die
// producten kennen, ook met een aantal: bij het bewaren wordt het één
// contactmoment per product (typesInAll()).
await geval("soorten voor meer producten samen", () => {
  const rfaStents = D.typesInAll(["Fibroid RFA", "Stents"], D.PRODUCTS);
  assert.ok(rfaStents.includes("order") && rfaStents.includes("procedure"), `Fibroid RFA + Stents: ${rfaStents}`);
  const gemengd = D.typesInAll(["EndoQ", "Stents"], D.PRODUCTS);
  assert.ok(gemengd.includes("order") && !gemengd.includes("procedure") && !gemengd.includes("installation"), `EndoQ + Stents: ${gemengd}`);
  assert.deepEqual(D.typesInAll(["Stents"], D.PRODUCTS), D.typesFor("Stents"));
});

klaar("regels", `${NIEUW.length} nieuwe momenten, ${AANPASSEN.length} aanpassingen, ${KEUZES.length} keuzes van producten`);
