// Een afspraak ziet er op twee plaatsen hetzelfde uit: als download in de app
// (public/ics.js) en in een agenda-abonnement (supabase/functions/calendar).
// De functie kan ics.js niet inlezen en houdt een kopie. Deze controle maakt
// dezelfde afspraken langs beide wegen en vergelijkt de tekst, regel voor
// regel, op het tijdstip van aanmaken na.
import assert from "node:assert/strict";
import { browserbestand, edgeFunctie, vertalingen } from "./laad.mjs";

const Ics = browserbestand("public/ics.js", { TextEncoder }).FollowUpIcs;
const V = vertalingen();

// Verzonnen momenten, met wat het moeilijk maakt: een uur dat over
// middernacht en jaareinde loopt, een hele dag, een land zonder tijdzone,
// leestekens die iCalendar moet ontsnappen en een nota langer dan één regel.
const MOMENTEN = [
  { id: "p1", date: "2026-12-31", time: "23:30", type: "demo", products: ["EndoQ"], hospital: "AZ Proef – Campus Écluse",
    address: "Proefstraat 1, 8800 Roeselare", country: "BE", note: "Uitleg; tweede punt, derde\nnieuwe regel " + "é".repeat(60) },
  { id: "p2", date: "2026-02-28", time: "", type: "procedure", products: ["Stents"], hospital: "UZ Verzonnen", address: "", country: "NL", note: "" },
  { id: "p3", date: "2026-03-01", time: "09:00", type: "visit", products: ["Thyroid RFA", "Fibroid RFA"], hospital: "Proefziekenhuis",
    address: "Laan 2", country: "AU", note: "" },
];

// Eén keer laden; wat de nagebootste databank antwoordt, zetten we per geval.
let antwoord;
const handler = await edgeFunctie("supabase/functions/calendar/index.ts", async (url) => {
  assert.ok(url.endsWith("/rpc/calendar_feed"), "onverwacht adres: " + url);
  return antwoord;
});
const vraag = async (geheim) => handler(new Request(`https://test.supabase.co/functions/v1/calendar/${geheim}.ics`));

for (const taal of ["nl", "en"]) {
  antwoord = [200, { label: "Proef", lang: taal, events: MOMENTEN }];
  const res = await vraag("a".repeat(64));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/calendar/);
  // Wat enkel een abonnement heeft (hoe vaak opnieuw ophalen) en het tijdstip
  // van aanmaken laten we weg; de rest moet gelijk zijn.
  const zonder = (tekst) => tekst.replace(/\r\n /g, "").split("\r\n")
    .filter((r) => !/^(DTSTAMP|REFRESH-INTERVAL|X-PUBLISHED-TTL):/.test(r.split(";")[0] + ":"));
  const verwacht = Ics.calendar(MOMENTEN.map((m) => ({
    id: m.id, date: m.date, time: m.time, country: m.country,
    title: Ics.title(V.t(taal, "act." + m.type), m.products, m.hospital),
    location: Ics.place(m.hospital, m.address), description: m.note,
  })), "FollowUp · Proef");
  assert.deepEqual(zonder(await res.text()), zonder(verwacht), `agenda (${taal}): het abonnement en de download verschillen`);
}

// Wat iemand met schrijfrecht in het document kan zetten, mag geen eigen
// regels in een agenda maken: een id met regeleinden (dat staat onontsnapt in
// UID) en een land dat in het prototype bestaat ("constructor").
const kwaad = { id: "x\r\nURL:https://kwaad.example\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:y", date: "2026-11-20",
  time: "10:00", type: "toString", products: [], hospital: "AZ Proef", address: "", country: "constructor", note: "" };
antwoord = [200, { label: "", lang: "nl", events: [kwaad, { ...kwaad, id: "goed1" }] }];
{
  const res = await vraag("d".repeat(64));
  assert.equal(res.status, 200, "een vreemd land of een vreemde soort laat het abonnement niet vallen");
  const tekst = await res.text();
  assert.ok(!/\r\nURL:/.test(tekst), "een id met regeleinden maakt geen eigen eigenschap in het abonnement");
  assert.equal((tekst.match(/BEGIN:VEVENT/g) || []).length, 1, "het moment met een kwaad id valt weg, het goede blijft");
  assert.match(tekst, /SUMMARY:Andere · AZ Proef/, "een onbekende soort heet 'Andere', niet een functie uit het prototype");
}
{
  const tekst = Ics.calendar([{ ...kwaad, title: "t", location: "", description: "" }], "");
  assert.ok(!/\r\nURL:/.test(tekst), "de download laat een id met regeleinden geen eigen eigenschap maken");
  assert.equal((tekst.match(/BEGIN:VEVENT/g) || []).length, 1, "de download maakt van één moment één afspraak");
}

// Een onbekend geheim en een databank die hapert zijn niet hetzelfde: met een
// 404 gooien sommige agenda's het abonnement weg.
antwoord = [200, null];
assert.equal((await vraag("b".repeat(64))).status, 404, "onbekend geheim hoort 404 te geven");
antwoord = [500, { message: "stuk" }];
assert.equal((await vraag("c".repeat(64))).status, 503, "een haperende databank hoort 503 te geven");
assert.equal((await vraag("geen-geheim")).status, 404, "iets dat geen geheim kan zijn hoort 404 te geven");

console.log("agenda: alles ok");
