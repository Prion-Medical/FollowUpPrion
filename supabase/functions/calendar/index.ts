// FollowUp Prion – agenda-abonnement.
//
// Een agenda-app (Outlook, Google, Apple) haalt dit adres zelf op, om de zoveel
// tijd, zonder dat er iemand aangemeld is:
//
//   https://<project>.supabase.co/functions/v1/calendar/<geheim>.ics
//
// Het geheim ís de aanmelding. Deze functie weet zelf niets: ze geeft het door
// aan public.calendar_feed(), en die beslist in de databank wat het abonnement
// mag tonen, met dezelfde productmuur als read_state(). Geen service-sleutel:
// de functie roept de databank aan met de publieke sleutel, als anon, en anon
// mag precies die ene functie uitvoeren.
//
// Eén bestand, geen imports, zoals de koppeling voor een assistent. In het
// dashboard plakken, met "Verify JWT" UIT: een agenda-app stuurt geen sleutel
// mee.
//
// De vorm van een afspraak is een kopie van public/ics.js (de download van één
// moment in de app). Verander je de ene, verander dan ook de andere.

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// De namen van de soorten, per taal. Een derde kopie (na i18n.js en de
// koppeling): de databank bewaart enkel de sleutel.
const TYPES: Record<string, Record<string, string>> = {
  nl: {
    prospecting: "Prospectie", email: "E-mail", call: "Telefoon", visit: "Bezoek",
    congress: "Congres / beurs", demo: "Demo", installation: "Installatie", training: "Training",
    quote: "Offerte", order: "Bestelling", cancellation: "Stopgezet", other: "Andere",
  },
  en: {
    prospecting: "Prospecting", email: "E-mail", call: "Call", visit: "Visit",
    congress: "Congress / fair", demo: "Demo", installation: "Installation", training: "Training",
    quote: "Quote", order: "Order", cancellation: "Stopped", other: "Other",
  },
};

// ---------- iCalendar: kopie van public/ics.js ----------

const ZONES: Record<string, string> = { BE: "Europe/Brussels", NL: "Europe/Brussels", LU: "Europe/Brussels" };
const VTIMEZONE: Record<string, string[]> = {
  "Europe/Brussels": [
    "BEGIN:VTIMEZONE", "TZID:Europe/Brussels",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
    "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
    "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
  ],
};

type Ev = { id: string; date: string; time: string; country: string; title: string; location: string; description: string };

const text = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
  .replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

function fold(line: string) {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "", size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > 75) { out.push(cur); cur = " "; size = 1; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
};
const day = (dt: Date) => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
const clock = (dt: Date) => `${day(dt)}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;

function event(ev: Ev, dtstamp: string) {
  const zone = ZONES[ev.country] || "";
  const start = parts(ev.date, ev.time);
  const lines = ["BEGIN:VEVENT", `UID:${ev.id}@followup.prionmedical.be`, `DTSTAMP:${dtstamp}`];
  if (ev.time) {
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const tz = zone ? `;TZID=${zone}` : "";
    lines.push(`DTSTART${tz}:${clock(start)}`, `DTEND${tz}:${clock(end)}`);
  } else {
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    lines.push(`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`, "TRANSP:TRANSPARENT");
  }
  lines.push(`SUMMARY:${text(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${text(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${text(ev.description)}`);
  lines.push("END:VEVENT");
  return lines;
}

function calendar(events: Ev[], name: string) {
  const dtstamp = clock(new Date()) + "Z";
  const zones = [...new Set(events.filter((e) => e.time).map((e) => ZONES[e.country]).filter(Boolean))];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Prion Medical//FollowUp//NL",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (name) lines.push(`X-WR-CALNAME:${text(name)}`);
  // Een hint, geen bevel: Apple en Outlook lezen ze, Google beslist zelf.
  lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
  for (const z of zones) lines.push(...VTIMEZONE[z]);
  for (const e of events) lines.push(...event(e, dtstamp));
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

const title = (typeLabel: string, products: string[], hospital: string) =>
  [typeLabel, (products || []).join(", "), hospital].filter(Boolean).join(" · ");
const place = (hospital: string, address: string) => [hospital, address].filter(Boolean).join(", ");

// ---------- de vraag zelf ----------

const plain = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

// Het geheim staat als laatste stuk van het pad, met of zonder .ics. Een agenda
// die een bestandsnaam wil zien, krijgt er zo een.
function secretOf(url: URL) {
  const last = url.pathname.split("/").pop() || "";
  return (url.searchParams.get("t") || last).replace(/\.ics$/i, "").toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return plain("method not allowed", 405, { Allow: "GET, HEAD" });
  const secret = secretOf(new URL(req.url));
  // Wat geen geheim kan zijn, gaat niet eens naar de databank.
  if (!/^[0-9a-f]{64}$/.test(secret)) return plain("not found", 404);

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/calendar_feed`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_secret: secret }),
    });
  } catch {
    return plain("temporarily unavailable", 503, { "Retry-After": "300" });
  }
  // Een fout van de databank is geen "bestaat niet": met een 404 gooien
  // sommige agenda's het abonnement weg.
  if (!res.ok) return plain("temporarily unavailable", 503, { "Retry-After": "300" });
  const feed = await res.json();
  // Onbekend of ingetrokken. Hetzelfde antwoord voor allebei: wie een adres
  // probeert, leert er niets uit.
  if (!feed) return plain("not found", 404);

  const lang = feed.lang === "en" ? "en" : "nl";
  const events: Ev[] = (Array.isArray(feed.events) ? feed.events : [])
    .filter((e: Record<string, unknown>) => typeof e.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)))
    .map((e: Record<string, unknown>) => ({
      id: String(e.id),
      date: String(e.date),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.time || "")) ? String(e.time) : "",
      country: String(e.country || ""),
      title: title(TYPES[lang][String(e.type)] || TYPES[lang].other,
        Array.isArray(e.products) ? e.products.map(String) : [], String(e.hospital || "")),
      location: place(String(e.hospital || ""), String(e.address || "")),
      description: String(e.note || ""),
    }));
  const name = feed.label ? `FollowUp · ${feed.label}` : "FollowUp";
  const body = calendar(events, name);
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="followup.ics"',
      // Niet bewaren onderweg: een ingetrokken abonnement moet meteen stoppen.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
});
