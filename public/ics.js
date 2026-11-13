/* FollowUp Prion – agendabestanden (iCalendar, RFC 5545).
 *
 * Eén geplande afspraak als bestand om te downloaden. Het abonnement doet
 * hetzelfde aan de serverkant, in supabase/functions/calendar/index.ts: die
 * functie kan dit bestand niet inlezen (één bestand, geen imports), dus daar
 * staat een kopie. Verander je hier iets aan de vorm van een afspraak, dan
 * ook daar — anders ziet een gedownloade afspraak er anders uit dan dezelfde
 * in het abonnement.
 *
 * Calendar files for one planned moment. The feed builds the same events on
 * the server side; keep the two in step.
 */
window.FollowUpIcs = (() => {
  "use strict";

  // Een moment met een uur staat in de tijdzone van het ziekenhuis. Voor de
  // Benelux is dat één regel (Brussel, Amsterdam en Luxemburg lopen gelijk).
  // Een land zonder zone hier krijgt een "zwevend" uur: 14:00 waar je ook
  // bent, wat voor een afspraak ter plaatse het juiste is.
  const ZONES = { BE: "Europe/Brussels", NL: "Europe/Brussels", LU: "Europe/Brussels" };
  const VTIMEZONE = {
    "Europe/Brussels": [
      "BEGIN:VTIMEZONE", "TZID:Europe/Brussels",
      "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
      "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
      "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
      "END:VTIMEZONE",
    ],
  };

  // Tekst in een eigenschap: backslash, puntkomma, komma en regeleinde
  // krijgen een backslash (RFC 5545, 3.3.11).
  const text = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

  // Een regel mag 75 bytes lang zijn; daarna gaat hij verder op een regel die
  // met een spatie begint. Bytes en geen tekens, en nooit midden in een teken:
  // een é is twee bytes, en een halve é leest elke agenda als rommel.
  function fold(line) {
    const enc = new TextEncoder();
    const out = [];
    let cur = "", size = 0, limit = 75;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (size + n > limit) { out.push(cur); cur = " "; size = 1; limit = 75; }
      cur += ch; size += n;
    }
    out.push(cur);
    return out.join("\r\n");
  }

  const pad = (n) => String(n).padStart(2, "0");
  // Rekenen in UTC, zodat de zomertijd van de browser zich er niet mee moeit:
  // dit zijn kalenderdagen en kloktijden, geen ogenblikken.
  const parts = (date, time) => {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = (time || "00:00").split(":").map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh, mm));
  };
  const day = (dt) => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
  const clock = (dt) => `${day(dt)}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;
  const stampNow = () => clock(new Date()) + "Z";

  // ev: { id, date, time, country, title, location, description }.
  // Zonder uur een hele dag; met een uur een uur lang.
  function event(ev, dtstamp) {
    const zone = ZONES[ev.country] || "";
    const start = parts(ev.date, ev.time);
    const lines = ["BEGIN:VEVENT",
      // Het id van het geplande moment: zo herkent een agenda een verzette
      // afspraak als dezelfde en zet ze er geen tweede naast.
      `UID:${ev.id}@followup.prionmedical.be`,
      `DTSTAMP:${dtstamp}`];
    if (ev.time) {
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const tz = zone ? `;TZID=${zone}` : "";
      lines.push(`DTSTART${tz}:${clock(start)}`, `DTEND${tz}:${clock(end)}`);
    } else {
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      lines.push(`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`,
        // Een hele dag blokkeert niets: de agenda toont je dan niet als bezet.
        "TRANSP:TRANSPARENT");
    }
    lines.push(`SUMMARY:${text(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${text(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${text(ev.description)}`);
    lines.push("END:VEVENT");
    return lines;
  }

  function calendar(events, name) {
    const dtstamp = stampNow();
    const zones = [...new Set(events.filter((e) => e.time).map((e) => ZONES[e.country]).filter(Boolean))];
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Prion Medical//FollowUp//NL",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    if (name) lines.push(`X-WR-CALNAME:${text(name)}`);
    for (const z of zones) lines.push(...VTIMEZONE[z]);
    for (const e of events) lines.push(...event(e, dtstamp));
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  // Titel en plaats, op één plek bepaald zodat de download en het abonnement
  // dezelfde afspraak tonen. typeLabel is al vertaald.
  const title = (typeLabel, products, hospital) =>
    [typeLabel, (products || []).join(", "), hospital].filter(Boolean).join(" · ");
  const place = (hospital, address) => [hospital, address].filter(Boolean).join(", ");

  return { calendar, title, place };
})();
