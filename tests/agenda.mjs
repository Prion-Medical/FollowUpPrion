// Wat een agenda-abonnement (supabase/functions/calendar) van de geplande
// momenten maakt. Tot november 2026 was er ook een download van één moment
// (public/ics.js) en vergeleek dit bestand die twee; die download is weg, dus
// staat hier wat het abonnement moet schrijven, regel voor regel, op het
// tijdstip van aanmaken na.
import assert from "node:assert/strict";
import { edgeFunctie, vertalingen } from "./laad.mjs";

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

// Wat er per moment in het abonnement hoort, zonder DTSTAMP (het tijdstip van
// aanmaken). Een uur in de Benelux staat in de zone van Brussel en loopt een
// uur, ook over middernacht en jaareinde; zonder uur is het een hele dag die
// niet als bezet telt; een land zonder zone krijgt een zwevend uur. Leestekens
// zijn ontsnapt en een lange regel is gevouwen.
const AFSPRAKEN = (soort) => [
  "BEGIN:VEVENT", "UID:p1@followup.prionmedical.be",
  "DTSTART;TZID=Europe/Brussels:20261231T233000", "DTEND;TZID=Europe/Brussels:20270101T003000",
  `SUMMARY:${soort("demo")} · EndoQ · AZ Proef – Campus Écluse`,
  "LOCATION:AZ Proef – Campus Écluse\\, Proefstraat 1\\, 8800 Roeselare",
  "DESCRIPTION:Uitleg\\; tweede punt\\, derde\\nnieuwe regel " + "é".repeat(60),
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:p2@followup.prionmedical.be",
  "DTSTART;VALUE=DATE:20260228", "DTEND;VALUE=DATE:20260301", "TRANSP:TRANSPARENT",
  `SUMMARY:${soort("procedure")} · Stents · UZ Verzonnen`, "LOCATION:UZ Verzonnen",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:p3@followup.prionmedical.be",
  "DTSTART:20260301T090000", "DTEND:20260301T100000",
  `SUMMARY:${soort("visit")} · Thyroid RFA\\, Fibroid RFA · Proefziekenhuis`, "LOCATION:Proefziekenhuis\\, Laan 2",
  "END:VEVENT",
];
for (const taal of ["nl", "en"]) {
  antwoord = [200, { label: "Proef", lang: taal, events: MOMENTEN }];
  const res = await vraag("a".repeat(64));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/calendar/);
  const tekst = await res.text();
  assert.ok(tekst.endsWith("END:VCALENDAR\r\n") && !/[^\r]\n/.test(tekst), `agenda (${taal}): elke regel eindigt op CRLF`);
  const lang = tekst.split("\r\n").filter((r) => new TextEncoder().encode(r).length > 75);
  assert.deepEqual(lang, [], `agenda (${taal}): een regel is langer dan 75 bytes`);
  const regels = tekst.replace(/\r\n /g, "").split("\r\n");
  assert.ok(regels.includes("X-WR-CALNAME:FollowUp · Proef"), `agenda (${taal}): de naam van het abonnement`);
  assert.ok(regels.includes("TZID:Europe/Brussels"), `agenda (${taal}): de tijdzone staat erin`);
  const afspraken = regels.slice(regels.indexOf("BEGIN:VEVENT"), regels.lastIndexOf("END:VEVENT") + 1).filter((r) => !r.startsWith("DTSTAMP:"));
  assert.deepEqual(afspraken, AFSPRAKEN((k) => V.t(taal, "act." + k)), `agenda (${taal}): de afspraken`);
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

// Een onbekend geheim en een databank die hapert zijn niet hetzelfde: met een
// 404 gooien sommige agenda's het abonnement weg.
antwoord = [200, null];
assert.equal((await vraag("b".repeat(64))).status, 404, "onbekend geheim hoort 404 te geven");
antwoord = [500, { message: "stuk" }];
assert.equal((await vraag("c".repeat(64))).status, 503, "een haperende databank hoort 503 te geven");
assert.equal((await vraag("geen-geheim")).status, 404, "iets dat geen geheim kan zijn hoort 404 te geven");

console.log("agenda: alles ok");
