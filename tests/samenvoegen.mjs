// merge3() in domain.js: twee mensen bewaren tegelijk. De databank weigert de
// tweede opslag; de app haalt het nieuwe document op, legt haar eigen
// wijziging erop en bewaart opnieuw. Gaat dat mis, dan verdwijnt stil het werk
// van een collega. Verzonnen gegevens, zoals overal hier.
import assert from "node:assert/strict";
import { domein, geval, klaar } from "./laad.mjs";

const { merge3 } = domein();
const kopie = (x) => JSON.parse(JSON.stringify(x));
const basis = {
  version: 1,
  hospitals: [
    { id: "h1", name: "AZ Proef", address: "Straat 1", notes: "", products: ["EndoQ"], status: "orange", stage: "meeting",
      pipeline: { EndoQ: { stage: "meeting", status: "orange", owner: "" } }, unit: { rooms: 4 },
      contacts: [{ id: "c1", name: "Dr. Proef", phone: "", email: "", products: ["EndoQ"] }],
      activities: [{ id: "a1", date: "2026-01-02", type: "call", product: "EndoQ", note: "eerste", createdBy: "u1", updatedAt: "t0" }],
      planned: [] },
    { id: "h2", name: "UZ Verzonnen", address: "", notes: "", products: [], status: "red", stage: "prospect",
      unit: {}, contacts: [], activities: [], planned: [] },
  ],
};
// Twee kopieën van de basis, elk door een andere hand aangepast.
const twee = (mijn, hun) => {
  const m = kopie(basis), h = kopie(basis);
  mijn(m); hun(h);
  const conflicten = [];
  return { uit: merge3(basis, m, h, conflicten), conflicten };
};

await geval("verschillende velden van hetzelfde record blijven allebei", () => {
  const { uit, conflicten } = twee((m) => { m.hospitals[0].address = "Straat 2"; }, (h) => { h.hospitals[0].notes = "nieuw"; });
  assert.deepEqual(conflicten, []);
  assert.equal(uit.hospitals[0].address, "Straat 2");
  assert.equal(uit.hospitals[0].notes, "nieuw");
});
await geval("hetzelfde veld anders aangepast is een conflict, met zijn plaats", () => {
  const { conflicten } = twee((m) => { m.hospitals[0].contacts[0].phone = "+32 1"; }, (h) => { h.hospitals[0].contacts[0].phone = "+32 2"; });
  assert.deepEqual(conflicten, [["hospitals", "h1", "contacts", "c1", "phone"]]);
});
await geval("aan elke kant een nieuw record: allebei", () => {
  const { uit, conflicten } = twee(
    (m) => { m.hospitals[0].activities.push({ id: "m1", date: "2026-02-01", type: "visit", product: "EndoQ", note: "" }); },
    (h) => { h.hospitals[0].activities.push({ id: "t1", date: "2026-02-02", type: "email", product: "EndoQ", note: "" }); });
  assert.deepEqual(conflicten, []);
  assert.deepEqual(uit.hospitals[0].activities.map((a) => a.id).sort(), ["a1", "m1", "t1"]);
});
await geval("hier verwijderd, daar onaangeroerd: weg", () => {
  const { uit, conflicten } = twee((m) => { m.hospitals[0].activities = []; }, () => {});
  assert.deepEqual(conflicten, []);
  assert.deepEqual(uit.hospitals[0].activities, []);
});
await geval("hier verwijderd, daar aangepast: blijft, als conflict", () => {
  const { uit, conflicten } = twee((m) => { m.hospitals[0].activities = []; }, (h) => { h.hospitals[0].activities[0].note = "aangepast"; });
  assert.deepEqual(conflicten, [["hospitals", "h1", "activities", "a1"]]);
  assert.equal(uit.hospitals[0].activities[0].note, "aangepast");
});
await geval("een stempel telt niet als wijziging", () => {
  // De databank zet de stempel opnieuw; dat mag een verwijdering hier niet
  // in een conflict veranderen.
  const { uit, conflicten } = twee((m) => { m.hospitals[0].activities = []; }, (h) => { h.hospitals[0].activities[0].updatedAt = "t9"; });
  assert.deepEqual(conflicten, []);
  assert.deepEqual(uit.hospitals[0].activities, []);
});
await geval("lijsten van records op id, niet op plaats", () => {
  const { uit, conflicten } = twee(
    (m) => { m.hospitals.reverse(); m.hospitals[1].address = "Straat 3"; },
    (h) => { h.hospitals[1].notes = "ook"; });
  assert.deepEqual(conflicten, []);
  const h1 = uit.hospitals.find((x) => x.id === "h1"), h2 = uit.hospitals.find((x) => x.id === "h2");
  assert.equal(h1.address, "Straat 3");
  assert.equal(h2.notes, "ook");
});
await geval("vinkjes: wat zij hebben, plus wat hier bijkwam, min wat hier wegging", () => {
  const { uit, conflicten } = twee(
    (m) => { m.hospitals[0].contacts[0].products = ["Ainex"]; },
    (h) => { h.hospitals[0].contacts[0].products = ["EndoQ", "Stents"]; });
  assert.deepEqual(conflicten, []);
  assert.deepEqual([...uit.hospitals[0].contacts[0].products].sort(), ["Ainex", "Stents"]);
});
await geval("een moment dat in de lijstvorm komt, blijft dat", () => {
  const { uit, conflicten } = twee(
    (m) => { const a = m.hospitals[0].activities[0]; delete a.product; a.products = ["EndoQ", "Ainex"]; },
    (h) => { h.hospitals[0].activities[0].note = "daar"; });
  assert.deepEqual(conflicten, []);
  const a = uit.hospitals[0].activities[0];
  assert.deepEqual(a.products, ["EndoQ", "Ainex"]);
  assert.ok(!("product" in a), "het oude product staat er nog naast");
  assert.equal(a.note, "daar");
});

klaar("samenvoegen");
