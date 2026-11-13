// Geplande momenten staan op drie plaatsen gesorteerd en afgevinkt: in de app
// (byWhen() en tickOffDate() in domain.js), in de koppeling (sortPlanned,
// complete_planned_moment) en in de databank (fix_planned in schema.sql).
// Loopt de volgorde uiteen, dan is de volgende actie op de kaart een ander
// moment dan het eerste in de agenda.
import assert from "node:assert/strict";
import { domein, geval, klaar, koppeling, lees } from "./laad.mjs";

const D = domein();
const K = await koppeling();
const zh = () => ({ id: "h", name: "AZ Proef", country: "BE", status: "red", stage: "prospect",
  products: [], contacts: [], activities: [], planned: [], unit: {} });
// Zoals de koppeling vandaag rekent: in Brussel, niet in UTC.
const vandaag = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
const dag = (n) => { const d = new Date(vandaag + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

await geval("plannen zonder datum", async () => {
  K.stand = { version: 1, hospitals: [zh()] };
  const r = await K.werktuig("add_planned_moment", { hospital_id: "h", type: "quote", product: "EndoQ", note: "ooit" });
  assert.ok(!r.fout, r.tekst);
  assert.equal(K.stand.hospitals[0].planned[0].date, "");
});

await geval("volgorde: datum, dan uur, zonder datum vooraan", async () => {
  K.stand = { version: 1, hospitals: [zh()] };
  for (const [date, time, note] of [[dag(5), "15:00", "middag"], [dag(5), "09:00", "ochtend"], [dag(5), "", "ergens die dag"], ["", "", "geen dag"], [dag(2), "", "eerder"]]) {
    const args = { hospital_id: "h", type: "call", product: "EndoQ", note };
    if (date) args.date = date;
    if (time) args.time = time;
    const r = await K.werktuig("add_planned_moment", args);
    assert.ok(!r.fout, r.tekst);
  }
  const h = K.stand.hospitals[0];
  const koppeling = h.planned.map((p) => p.note);
  const app = [...h.planned].sort(D.byWhen).map((p) => p.note);
  assert.deepEqual(koppeling, app, "de koppeling legt ze anders dan de app");
  assert.deepEqual(app, ["geen dag", "eerder", "ochtend", "middag", "ergens die dag"]);
  assert.equal(h.nextAction, "geen dag", "nextAction is niet het eerste moment");
  assert.equal(h.nextActionDate, "");
});

await geval("volgorde: de databank sorteert zoals byWhen", () => {
  // fix_planned in schema.sql: datum, dan uur (wat geen uur heeft: "99"), dan
  // de volgorde waarin het stond.
  assert.match(lees("supabase/schema.sql"),
    /jsonb_agg\(t\.e order by coalesce\(t\.e ->> 'date', ''\), coalesce\(t\.e ->> 'time', '99'\), t\.i\)/,
    "fix_planned sorteert niet meer op datum en uur");
});

// Afvinken: het id gaat mee (zo ziet de databank dat het afvinken is en geen
// verwijderen), het uur niet (een contactmoment heeft een datum en geen uur),
// de soort stent wel, en de datum is ten laatste vandaag.
for (const [naam, date] of [["voorbij", dag(-3)], ["vandaag", vandaag], ["toekomst", dag(4)], ["zonder datum", ""]]) {
  await geval(`afvinken: plan ${naam}`, async () => {
    const plan = { id: "p1", date, type: "order", product: "Stents", family: "biliary", note: "", contactId: "" };
    if (date) plan.time = "10:00";
    K.stand = { version: 1, hospitals: [{ ...zh(), products: ["Stents"], planned: [plan] }] };
    const r = await K.werktuig("complete_planned_moment", { hospital_id: "h", planned_id: "p1", quantity: 6 });
    assert.ok(!r.fout, r.tekst);
    const h = K.stand.hospitals[0];
    assert.equal(h.planned.length, 0, "het plan staat er nog");
    const a = h.activities.find((x) => x.id === "p1");
    assert.ok(a, "het contactmoment draagt het id van het plan niet");
    assert.ok(!("time" in a), "het uur ging mee");
    assert.equal(a.family, "biliary", "de soort stent ging niet mee");
    assert.equal(a.rooms, 6);
    assert.equal(a.date, D.tickOffDate(plan, vandaag), "de datum volgt een andere regel dan de app");
  });
}

// Voor wie: wie gekozen is, anders wie het invoerde. De koppeling meldt het
// als planned_for; de agenda en de filter lezen assigneeOf().
await geval("voor wie", async () => {
  const momenten = [
    { id: "a", date: dag(1), type: "call", product: "", note: "", createdBy: "u1" },
    { id: "b", date: dag(1), type: "call", product: "", note: "", createdBy: "u1", assignee: "u2" },
    { id: "c", date: dag(1), type: "call", product: "", note: "", createdBy: "", assignee: "u2" },
    { id: "d", date: dag(1), type: "call", product: "", note: "" },
  ];
  K.stand = { version: 1, hospitals: [{ ...zh(), planned: momenten }] };
  const r = await K.werktuig("list_moments", { kind: "planned", hospital_id: "h" });
  assert.ok(!r.fout, r.tekst);
  const naam = (id) => (K.mensen.find((m) => m.id === id) || {}).name || "";
  for (const m of momenten) {
    const rij = r.uit.moments.find((x) => x.id === m.id);
    assert.equal(rij.planned_for, naam(D.assigneeOf(m)), `${m.id}: de koppeling noemt iemand anders dan de app`);
  }
});

klaar("planning");
