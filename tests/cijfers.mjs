// Hoe kamers en verkochte stuks geteld worden, staat twee keer: in domain.js
// (units, rooms, signedRooms; de statistiekenpagina rekent ermee) en in de
// koppeling (get_statistics, zodat een assistent dezelfde cijfers noemt).
// Deze controle telt dezelfde verzonnen momenten langs beide.
import assert from "node:assert/strict";
import { domein, geval, klaar, koppeling } from "./laad.mjs";

const D = domein();
const K = await koppeling();
const sum = (lijst, f) => lijst.reduce((s, x) => s + f(x), 0);

// Aantallen zoals ze in echte gegevens opduiken: niets, leeg, nul, tekst, een
// negatief getal, onzin. En een gesprek over twee producten, dat nergens als
// verkoop mag meetellen.
const momenten = [
  { id: "o1", date: "2026-03-01", type: "order", products: ["Stents"], rooms: null, family: "biliary" },
  { id: "o2", date: "2026-03-02", type: "order", products: ["Stents"], rooms: "", family: "colonic" },
  { id: "o3", date: "2026-03-03", type: "order", products: ["Stents"], rooms: 0 },
  { id: "o4", date: "2026-03-04", type: "order", products: ["Stents"], rooms: "3", family: "biliary" },
  { id: "o5", date: "2026-03-05", type: "order", products: ["Stents"], rooms: -2 },
  { id: "o6", date: "2026-03-06", type: "order", products: ["Stents"], rooms: "x" },
  { id: "p1", date: "2026-03-07", type: "procedure", products: ["Stents"], rooms: null },
  { id: "p2", date: "2026-03-08", type: "procedure", products: ["Stents"], rooms: 4, family: "other" },
  { id: "p3", date: "2026-03-09", type: "procedure", products: ["Thyroid RFA"], rooms: 2 },
  { id: "v1", date: "2026-03-10", type: "visit", products: ["Thyroid RFA", "Stents"] },
  // Een bestelling en een installatie over twee producten, zonder aantal: een
  // aantal hoort bij één product, dus tellen ze voor geen van beide.
  { id: "m1", date: "2026-03-11", type: "order", products: ["Thyroid RFA", "Stents"], rooms: null },
  { id: "m2", date: "2026-02-05", type: "installation", products: ["EndoQ", "Ainex"], rooms: null },
  // Ook met een aantal (oude of met de hand gemaakte gegevens): een procedure
  // en een stopzetting over twee producten tellen nergens.
  { id: "m3", date: "2026-03-12", type: "procedure", products: ["Thyroid RFA", "Stents"], rooms: 2 },
  { id: "m4", date: "2026-02-06", type: "cancellation", products: ["EndoQ", "Ainex"], rooms: 2 },
  { id: "m5", date: "2026-02-07", type: "order", products: ["EndoQ", "Ainex"], rooms: null },
  { id: "m6", date: "2026-02-09", type: "demo", products: ["EndoQ", "Ainex"], rooms: null },
  // Een bestelling die de databank voor dit account tot één product inkortte:
  // ze ziet eruit als een gewone bestelling Stents, maar is gedeeld.
  { id: "s1", date: "2026-03-13", type: "order", products: ["Stents"], shared: true, rooms: 7 },
  { id: "i1", date: "2026-02-01", type: "installation", products: ["EndoQ"], rooms: 3 },
  { id: "i2", date: "2026-02-02", type: "installation", products: ["EndoQ"], rooms: null },
  { id: "c1", date: "2026-02-03", type: "cancellation", products: ["EndoQ"], rooms: 2 },
  { id: "c2", date: "2026-02-04", type: "cancellation", products: ["EndoQ"], rooms: 9 },
  // Zodat de actieve kamers boven nul blijven en een verkeerd meegeteld
  // moment er iets aan verandert.
  { id: "i3", date: "2026-02-08", type: "installation", products: ["EndoQ"], rooms: 20 },
].map((a) => ({ note: "", contactId: "", ...a }));

K.stand = { version: 1, hospitals: [{ id: "h", name: "AZ Proef", country: "BE", status: "orange", stage: "meeting",
  products: ["Stents", "Thyroid RFA", "EndoQ"], contacts: [], activities: momenten, planned: [], unit: {} }] };
const r = await K.werktuig("get_statistics", { from: "2026-01-01", to: "2026-12-31" });
assert.ok(!r.fout, r.tekst);
const per = Object.fromEntries(r.uit.products.map((p) => [p.product, p]));
// Wat per product telt: een moment over precies dat ene product, niet gedeeld.
const van = (p) => momenten.filter((a) => !D.shared(a) && D.productOf(a) === p);

for (const p of ["Stents", "Thyroid RFA"]) {
  await geval(`verkochte stuks ${p}`, () => {
    const verkocht = van(p).filter((a) => D.SOLD_TYPES.includes(a.type));
    assert.equal(per[p].units_sold_in_period, sum(verkocht, D.units), "totaal");
    assert.equal(per[p].of_which_on_orders, sum(verkocht.filter((a) => a.type === "order"), D.units), "op bestellingen");
    assert.equal(per[p].of_which_used_during_procedures, sum(verkocht.filter((a) => a.type === "procedure"), D.units), "tijdens procedures");
    assert.equal(per[p].target.units_sold_in_year, sum(verkocht, D.units), "in het jaar");
    assert.equal(per[p].orders_in_period, van(p).filter((a) => a.type === "order").length, "bestellingen");
    assert.equal(per[p].procedures_in_period, van(p).filter((a) => a.type === "procedure").length, "procedures");
  });
}
await geval("verkochte stuks per soort stent", () => {
  const verkocht = van("Stents").filter((a) => D.SOLD_TYPES.includes(a.type));
  for (const k of [...D.familiesFor("Stents"), ""]) {
    assert.equal(per.Stents.units_sold_by_family[k || "no_family_given"], sum(verkocht.filter((a) => (a.family || "") === k), D.units), k || "zonder soort");
  }
});
await geval("actieve kamers EndoQ", () => {
  // De statistiekenpagina telt installaties en stopzettingen met signedRooms
  // en kent geen negatieve stand.
  const gebeurd = van("EndoQ").filter((a) => a.type === "installation" || a.type === "cancellation");
  assert.equal(per.EndoQ.active_rooms_now, Math.max(0, sum(gebeurd, D.signedRooms)));
  assert.equal(per.EndoQ.rooms_installed_in_period, sum(gebeurd.filter((a) => a.type === "installation"), D.rooms));
  assert.equal(per.EndoQ.rooms_cancelled_in_period, sum(gebeurd.filter((a) => a.type === "cancellation"), D.rooms), "stopgezet");
  assert.equal(per.EndoQ.installations_in_period, gebeurd.filter((a) => a.type === "installation").length, "installaties");
  assert.equal(per.EndoQ.orders_in_period, van("EndoQ").filter((a) => a.type === "order").length, "bestellingen");
  assert.equal(per.EndoQ.demos_in_period, van("EndoQ").filter((a) => a.type === "demo").length, "demo's");
});

klaar("cijfers");
