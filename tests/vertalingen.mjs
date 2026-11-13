// Elke sleutel in beide talen, en elke sleutel die de code vraagt bestaat.
// Een ontbrekende Engelse sleutel valt stil terug op het Nederlands, dus die
// zie je in de app niet; hier wel.
import assert from "node:assert/strict";
import { domein, geval, klaar, lees, letterlijk, vertalingen } from "./laad.mjs";

const V = vertalingen();
const D = domein();

await geval("beide talen", () => {
  assert.deepEqual([...V.nl].filter((k) => !V.en.has(k)), [], "enkel in het Nederlands");
  assert.deepEqual([...V.en].filter((k) => !V.nl.has(k)), [], "enkel in het Engels");
});

// Sleutels die letterlijk in de code staan.
await geval("gevraagde sleutels", () => {
  const code = ["public/app.js", "public/stats.js", "public/domain.js", "public/ui.js", "public/storage.js", "public/consent.js"]
    .map(lees).join("\n");
  const html = ["public/index.html", "public/consent.html"].map(lees).join("\n");
  const gevraagd = new Set([
    ...[...code.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.]+)["']/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-ph|-title)?="([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]),
  ].filter((k) => !k.endsWith(".")));
  assert.deepEqual([...gevraagd].filter((k) => !V.nl.has(k)), [], "de code vraagt een sleutel die niet bestaat");
});

// Sleutels die in stukken worden samengesteld, t("stage." + s): die ziet de
// zoekactie hierboven niet. Per voorvoegsel de lijst waar de stukken uit
// komen; een nieuwe regio, fase of dienst zonder vertaling valt hier op.
const app = lees("public/app.js");
const families = [...new Set(D.PRODUCTS.flatMap((p) => D.familiesFor(p)))];
const SAMENGESTELD = [
  ["act.", Object.keys(D.ACT_TYPES)],
  ["stage.", D.STAGES],
  ["status.", D.STATUSES],
  ["status.", D.STATUSES, ".short"],
  ["country.", D.COUNTRIES],
  ["country.", D.COUNTRIES, ".short"],
  ["region.", D.REGION_KEYS],
  ["sector.", D.SECTORS],
  ["dept.", D.DEPARTMENTS],
  ["role.", D.ROLES],
  ["role.", D.ROLES, ".hint"],
  ["rfa.cmm.", D.CMM_STATES],
  ["rfa.", [...new Set(D.PRODUCTS.flatMap((p) => D.factsFor(p)))]],
  ["yn.", D.YES_NO],
  ["family.", families],
  ["export.period.", Object.keys(letterlijk(app, "EXPORT_PERIODS"))],
  ["log.period.", letterlijk(app, "LOG_PERIODS")],
  ["feeds.how.", ["apple", "google", "outlook"]],
  ["feeds.how.", ["apple", "google", "outlook"], ".steps"],
];
for (const [voor, lijst, na = ""] of SAMENGESTELD) {
  await geval(`${voor}…${na}`, () => {
    const mist = lijst.flatMap((k) => ["nl", "en"].filter((taal) => !V[taal].has(voor + k + na)).map((taal) => `${voor}${k}${na} (${taal})`));
    assert.deepEqual(mist, [], "ontbreekt");
  });
}

klaar("vertalingen", `${V.nl.size} sleutels per taal`);
