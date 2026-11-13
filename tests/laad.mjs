// FollowUp Prion – de code laden zonder browser en zonder databank.
//
// Gedeeld door de controles in deze map. Alles hier gebruikt verzonnen
// gegevens; er gaat niets naar een netwerk. Zie tests/alles.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const lees = (pad) => readFileSync(ROOT + pad, "utf8");

// Een bestand uit public/ uitvoeren zoals de browser het doet: het hangt zijn
// eigen object aan window.
export function browserbestand(pad, window = {}) {
  window.window = window;
  new Function("window", "document", "localStorage", "navigator", lees(pad))(
    window,
    { documentElement: {}, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    { getItem: () => null, setItem() {}, removeItem() {} },
    { language: "nl" },
  );
  return window;
}

export const domein = () => browserbestand("public/domain.js").FollowUpDomain;

// De vertalingen: t() per taal, en de sleutels per taal zoals ze in het
// bestand staan (t() zelf valt terug op het Nederlands en verbergt zo een
// ontbrekende Engelse sleutel).
export function vertalingen() {
  const I = browserbestand("public/i18n.js").FollowUpI18n;
  const tekst = lees("public/i18n.js");
  const en = tekst.search(/^\s+en: \{/m);
  const sleutels = (deel) => new Set([...deel.matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]));
  const t = (taal, k) => { I.setLang(taal); return I.t(k); };
  return { t, nl: sleutels(tekst.slice(0, en)), en: sleutels(tekst.slice(en)) };
}

// Een losse waarde uit de broncode, zoals `const PRODUCTS = [...]`. Enkel
// voor letterlijke lijsten en objecten van tekst: wat erna komt tot de
// sluitende haak wordt als JavaScript gelezen. Verankerd aan het begin van een
// regel (met of zonder inspringing) en precies één keer: een tweede of een
// uitgecommentarieerde declaratie mag niet stil de verkeerde zijn.
export function letterlijk(bron, naam) {
  const re = new RegExp(`^[ \\t]*const ${naam}(?::[^=\\n]+)? = `, "gm");
  const treffers = [...bron.matchAll(re)];
  if (treffers.length !== 1) throw new Error(`${naam}: ${treffers.length} declaraties gevonden, één verwacht`);
  const m = treffers[0];
  const start = m.index + m[0].length;
  const open = bron[start], dicht = open === "[" ? "]" : "}";
  let diepte = 0;
  for (let i = start; i < bron.length; i++) {
    if (bron[i] === open) diepte++;
    else if (bron[i] === dicht && --diepte === 0) return new Function(`return ${bron.slice(start, i + 1)}`)();
  }
  throw new Error(`${naam} niet afgesloten`);
}

// Een Edge Function laden met een nagebootste Deno en fetch. antwoord(url,
// opties) geeft terug wat de databank zou zeggen. Geeft de handler terug die
// Deno.serve kreeg.
export async function edgeFunctie(pad, antwoord) {
  let handler;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "anon" })[k] },
    serve: (fn) => { handler = fn; },
  };
  globalThis.fetch = async (url, opt = {}) => {
    const [status, body] = await antwoord(String(url), opt);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  // Eén keer per bestand: Node voert een module maar één keer uit. Wie
  // verschillende antwoorden wil, laat antwoord() zelf wisselen.
  await import(new URL("../" + pad, import.meta.url).href);
  return handler;
}

// De koppeling voor een assistent, met een nagebootste databank. stand is het
// document dat read_state teruggeeft (al afgeschermd, zoals de databank dat
// doet), scope het bereik van het account (leeg = alles).
export async function koppeling() {
  const kopie = (x) => JSON.parse(JSON.stringify(x));
  const ctx = {
    stand: { version: 1, hospitals: [] },
    scope: [],
    mensen: [{ id: "u1", name: "Proef Persoon", products: [] }, { id: "u2", name: "Collega Proef", products: [] }],
  };
  const handler = await edgeFunctie("supabase/functions/agent/index.ts", async (url, opt) => {
    if (url.endsWith("/auth/v1/user")) return [200, { id: "u1" }];
    if (url.includes("/app_users")) return [200, ctx.mensen];
    if (url.endsWith("/rpc/read_state")) return [200, { data: kopie(ctx.stand), updated_at: "t1", role: "editor", products: ctx.scope }];
    if (url.endsWith("/rpc/write_state")) { ctx.stand = JSON.parse(opt.body).payload; return [200, "t2"]; }
    throw new Error("onverwacht adres: " + url);
  });
  ctx.werktuig = async (naam, args) => {
    const res = await handler(new Request("https://test.supabase.co/functions/v1/agent", {
      method: "POST",
      headers: { Authorization: "Bearer proef", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: naam, arguments: args } }),
    }));
    const r = (await res.json()).result;
    const tekst = r.content[0].text;
    let uit = null;
    try { uit = JSON.parse(tekst); } catch { /* een foutmelding is tekst */ }
    return { fout: !!r.isError, tekst, uit };
  };
  return ctx;
}

// Elk geval apart: een fout wordt genoteerd en het volgende geval loopt toch.
// Zo toont één run alle gevallen die stuk zijn, niet enkel het eerste.
const fouten = [];
export async function geval(naam, fn) {
  try { await fn(); } catch (e) { fouten.push(`${naam}: ${String(e.message).split("\n")[0]}`); }
}
export function klaar(bestand, uitleg = "") {
  if (!fouten.length) return console.log(`${bestand}: alles ok${uitleg ? ` (${uitleg})` : ""}`);
  console.error(`${bestand}: ${fouten.length} fout(en)\n  - ${fouten.join("\n  - ")}`);
  process.exitCode = 1;
}
