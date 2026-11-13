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
  { id: "o1", date: "2026-03-01", type: "order", product: "Stents", rooms: null, family: "biliary" },
  { id: "o2", date: "2026-03-02", type: "order", product: "Stents", rooms: "", family: "colonic" },
  { id: "o3", date: "2026-03-03", type: "order", product: "Stents", rooms: 0 },
  { id: "o4", date: "2026-03-04", type: "order", product: "Stents", rooms: "3", family: "biliary" },
  { id: "o5", date: "2026-03-05", type: "order", product: "Stents", rooms: -2 },
  { id: "o6", date: "2026-03-06", type: "order", product: "Stents", rooms: "x" },
  { id: "p1", date: "2026-03-07", type: "procedure", product: "Stents", rooms: null },
  { id: "p2", date: "2026-03-08", type: "procedure", product: "Stents", rooms: 4, family: "other" },
  { id: "p3", date: "2026-03-09", type: "procedure", product: "Thyroid RFA", rooms: 2 },
  { id: "v1", date: "2026-03-10", type: "visit", products: ["Thyroid RFA", "Stents"] },
  { id: "i1", date: "2026-02-01", type: "installation", product: "EndoQ", rooms: 3 },
  { id: "i2", date: "2026-02-02", type: "installation", product: "EndoQ", rooms: null },
  { id: "c1", date: "2026-02-03", type: "cancellation", product: "EndoQ", rooms: 2 },
  { id: "c2", date: "2026-02-04", type: "cancellation", product: "EndoQ", rooms: 9 },
].map((a) => ({ note: "", contactId: "", ...a }));

K.stand = { version: 1, hospitals: [{ id: "h", name: "AZ Proef", country: "BE", status: "orange", stage: "meeting",
  products: ["Stents", "Thyroid RFA", "EndoQ"], contacts: [], activities: momenten, planned: [], unit: {} }] };
const r = await K.werktuig("get_statistics", { from: "2026-01-01", to: "2026-12-31" });
assert.ok(!r.fout, r.tekst);
const per = Object.fromEntries(r.uit.products.map((p) => [p.product, p]));

for (const p of ["Stents", "Thyroid RFA"]) {
  await geval(`verkochte stuks ${p}`, () => {
    const verkocht = momenten.filter((a) => D.productOf(a) === p && D.SOLD_TYPES.includes(a.type));
    assert.equal(per[p].units_sold_in_period, sum(verkocht, D.units), "totaal");
    assert.equal(per[p].of_which_on_orders, sum(verkocht.filter((a) => a.type === "order"), D.units), "op bestellingen");
    assert.equal(per[p].of_which_used_during_procedures, sum(verkocht.filter((a) => a.type === "procedure"), D.units), "tijdens procedures");
    assert.equal(per[p].target.units_sold_in_year, sum(verkocht, D.units), "in het jaar");
  });
}
await geval("verkochte stuks per soort stent", () => {
  const verkocht = momenten.filter((a) => D.productOf(a) === "Stents" && D.SOLD_TYPES.includes(a.type));
  for (const k of [...D.familiesFor("Stents"), ""]) {
    assert.equal(per.Stents.units_sold_by_family[k || "no_family_given"], sum(verkocht.filter((a) => (a.family || "") === k), D.units), k || "zonder soort");
  }
});
await geval("actieve kamers EndoQ", () => {
  // De statistiekenpagina telt installaties en stopzettingen met signedRooms
  // en kent geen negatieve stand.
  const gebeurd = momenten.filter((a) => D.productOf(a) === "EndoQ" && (a.type === "installation" || a.type === "cancellation"));
  assert.equal(per.EndoQ.active_rooms_now, Math.max(0, sum(gebeurd, D.signedRooms)));
  assert.equal(per.EndoQ.rooms_installed_in_period, sum(gebeurd.filter((a) => a.type === "installation"), D.rooms));
});

klaar("cijfers");
