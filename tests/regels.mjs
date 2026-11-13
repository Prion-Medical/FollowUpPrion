// Wat een contactmoment doet met de kleur, de fase en de kamers staat twee
// keer: in domain.js en in de koppeling voor een assistent. Deze controle legt
// hetzelfde moment op hetzelfde ziekenhuis langs beide en vergelijkt de
// uitkomst. Verschillen ze, dan zet hetzelfde bezoek een ziekenhuis anders
// naargelang het met de hand of via een assistent is ingevoerd.
//
// De app-kant zijn de regels uit domain.js, dezelfde die app.js gebruikt.
// De koppeling-kant is het echte werktuig (add_contact_moment,
// update_moment), met een nagebootste databank. Ook welke soorten een keuze
// van producten toelaat wordt hier naast typesAmong() uit domain.js gelegd.
import assert from "node:assert/strict";
import { domein, geval, klaar, koppeling } from "./laad.mjs";

const D = domein();
const K = await koppeling();
const kopie = (x) => JSON.parse(JSON.stringify(x));

// --- de app ------------------------------------------------------------------
// Zoals activityDialog() een nieuw contactmoment bewaart.
function nieuwViaApp(zh, moment) {
  const h = kopie(zh);
  const rec = { id: "nieuw", date: "2026-10-01", type: moment.type, note: "", contactId: "" };
  if (moment.products.length > 1) rec.products = moment.products; else rec.product = moment.products[0] || "";
  rec.rooms = !D.shared(rec) && D.wantsQuantity(moment.type, D.productOf(rec)) ? moment.rooms ?? null : null;
  if (moment.family && D.wantsFamily(moment.type, D.productOf(rec))) rec.family = moment.family;
  h.activities.push(rec);
  for (const p of D.productsOf(rec)) if (!h.products.includes(p)) h.products.push(p);
  D.syncPipeline(h);
  D.autoStatus(h, rec);
  D.syncRooms(h, null, rec);
  return h;
}
// Zoals activityDialog() een bestaand contactmoment aanpast.
function wijzigViaApp(zh, id, wijziging) {
  const h = kopie(zh);
  const rec = h.activities.find((a) => a.id === id);
  const before = { type: rec.type, rooms: rec.rooms, product: D.productOf(rec) };
  Object.assign(rec, wijziging);
  if (!D.wantsQuantity(rec.type, D.productOf(rec))) rec.rooms = null;
  D.syncPipeline(h);
  if (before.type !== rec.type) D.autoStatus(h, rec);
  D.syncRooms(h, before, rec);
  return h;
}

// --- de koppeling --------------------------------------------------------------
async function nieuwViaKoppeling(zh, moment) {
  K.stand = { version: 1, hospitals: [kopie(zh)] };
  K.scope = [];
  const args = { hospital_id: zh.id, type: moment.type, date: "2026-10-01" };
  if (moment.products.length > 1) args.products = moment.products;
  else if (moment.products.length) args.product = moment.products[0];
  if (moment.rooms != null) args.quantity = moment.rooms;
  if (moment.family) args.family = moment.family;
  const r = await K.werktuig("add_contact_moment", args);
  assert.ok(!r.fout, `de koppeling weigerde: ${r.tekst}`);
  return K.stand.hospitals[0];
}
async function wijzigViaKoppeling(zh, id, args) {
  K.stand = { version: 1, hospitals: [kopie(zh)] };
  K.scope = [];
  const r = await K.werktuig("update_moment", { kind: "contact_moment", hospital_id: zh.id, record_id: id, ...args });
  assert.ok(!r.fout, `de koppeling weigerde: ${r.tekst}`);
  return K.stand.hospitals[0];
}

// Wat we vergelijken: kleur, fase, de opvolging per product, de
// geïnstalleerde kamers en het contactmoment zelf (soort, producten, aantal,
// soort stent). Niet roomsDemo: de koppeling laat dat bewust aan de databank
// over (fix_rooms_demo() in schema.sql, gecontroleerd door controle.sql
// 25-26), die het na elke opslag met een gewijzigde demo herrekent.
const samenvatting = (h, id) => {
  const a = id ? h.activities.find((x) => x.id === id) : h.activities[h.activities.length - 1];
  return {
    status: h.status, stage: h.stage, products: [...h.products].sort(),
    pipeline: Object.fromEntries(Object.entries(h.pipeline || {}).map(([p, e]) => [p, { stage: e.stage, status: e.status }])),
    roomsInstalled: h.unit.roomsInstalled ?? null,
    moment: a && { type: a.type, products: D.productsOf(a), lijst: D.shared(a), rooms: a.rooms ?? null, family: a.family || "" },
  };
};

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
  ["bezoek zonder product bij twee producten: niets beweegt",
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
  ["procedure bij een klant blijft klant",
    zh({ products: ["Thyroid RFA"], status: "green", stage: "customer", pipeline: { "Thyroid RFA": rij("customer", "green") } }),
    { type: "procedure", products: ["Thyroid RFA"], rooms: 3 }],
  ["bestelling voor een abonnementsproduct",
    zh({ products: ["Ainex"], status: "orange", stage: "first_contact", pipeline: { Ainex: rij("first_contact", "orange") } }),
    { type: "order", products: ["Ainex"], rooms: 2 }],
  ["tweede product bij een ziekenhuis dat er al een heeft",
    zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") } }),
    { type: "call", products: ["Stents"] }],
];
for (const [naam, start, moment] of NIEUW) {
  await geval(`nieuw: ${naam}`, async () => {
    assert.deepEqual(samenvatting(await nieuwViaKoppeling(start, moment)), samenvatting(nieuwViaApp(start, moment)), "de koppeling komt anders uit dan de app");
  });
}

// Een moment aanpassen: het verschil in kamers, en een andere soort beweegt
// de opvolging mee.
const geinstalleerd = zh({ products: ["EndoQ"], status: "green", stage: "customer", pipeline: { EndoQ: rij("customer", "green") },
  unit: { roomsInstalled: 3 },
  activities: [{ id: "i1", date: "2026-09-01", type: "installation", product: "EndoQ", rooms: 3, note: "", contactId: "" }] });
const gesprek = zh({ products: ["EndoQ"], status: "orange", stage: "meeting", pipeline: { EndoQ: rij("meeting", "orange") },
  activities: [{ id: "c1", date: "2026-09-01", type: "call", product: "EndoQ", rooms: null, note: "", contactId: "" }] });
const AANPASSEN = [
  ["installatie van 3 naar 5 kamers", geinstalleerd, "i1", { rooms: 5 }, { quantity: 5 }],
  ["installatie wordt een stopzetting", geinstalleerd, "i1", { type: "cancellation" }, { type: "cancellation" }],
  ["een gesprek wordt een installatie", gesprek, "c1", { type: "installation", rooms: 2 }, { type: "installation", quantity: 2 }],
];
for (const [naam, start, id, app, args] of AANPASSEN) {
  await geval(`aanpassen: ${naam}`, async () => {
    assert.deepEqual(samenvatting(await wijzigViaKoppeling(start, id, args), id), samenvatting(wijzigViaApp(start, id, app), id),
      "de koppeling komt anders uit dan de app");
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
      K.stand = { version: 1, hospitals: [zh()] };
      K.scope = bereik;
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
  K.stand = { version: 1, hospitals: [kopie(gedeeld)] };
  K.scope = ["Thyroid RFA"];
  const r = await K.werktuig("update_moment", { kind: "contact_moment", hospital_id: "h", record_id: "g1", type: "order", quantity: 5 });
  assert.ok(r.fout, "aanvaard: " + r.tekst);
});
await geval("gedeeld plan: afvinken met een aantal wordt geweigerd", async () => {
  K.stand = { version: 1, hospitals: [kopie(gedeeld)] };
  K.scope = ["Thyroid RFA"];
  const r = await K.werktuig("complete_planned_moment", { hospital_id: "h", planned_id: "gp1", quantity: 3 });
  assert.ok(r.fout, "aanvaard: " + r.tekst);
});
await geval("gedeeld plan: afvinken houdt de lijstvorm", async () => {
  K.stand = { version: 1, hospitals: [kopie(gedeeld)] };
  K.scope = ["Thyroid RFA"];
  const r = await K.werktuig("complete_planned_moment", { hospital_id: "h", planned_id: "gp1", date: "2026-09-20" });
  assert.ok(!r.fout, r.tekst);
  const a = K.stand.hospitals[0].activities.find((x) => x.id === "gp1");
  assert.ok(D.shared(a), "het contactmoment staat niet meer in de lijstvorm");
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
