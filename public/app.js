/* FollowUp Prion – opvolging EndoQ & Ainex in de Benelux.
 * Follow-up of EndoQ & Ainex in the Benelux. */
(() => {
  "use strict";

  const I18N = window.FollowUpI18n;
  const t = (k, v) => I18N.t(k, v);

  // Vaste waarden en esc() staan in domain.js: stats.js heeft ze ook nodig, en
  // zo moet een nieuwe fase of een nieuw merk maar op één plaats bij.
  const {
    DB_VERSION, STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS,
    PRODUCTS, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, LANGUAGES, COUNTRIES, ROLES,
    CMM_STATES, YES_NO, productKind, wantsQuantity, stagesFor, furthest, pipelineView,
    esc, icon, pickBox, syncPick, myProducts, productColor,
  } = window.FollowUpDomain;
  // Welk product staat standaard in een nieuw contactmoment of een planning:
  // dat van het ziekenhuis als er maar één is, anders het jouwe als jij er maar
  // één mag.
  const defaultProduct = (h) => (h.products.length === 1 ? h.products[0]
    : (myProducts().length === 1 ? myProducts()[0] : ""));

  // Scope-merken zijn eigennamen; enkel "other" is een sleutel met vertaling.
  const scopeLabel = (b) => (b === "other" ? t("scope.other") : b);
  // Benelux: west/zuid → oost/noord.
  const REGION_BOUNDS = [[49.3, 2.3], [53.7, 7.4]];
  const REGION_BBOX = [2.3, 49.3, 7.4, 53.7];

  const state = {
    db: { version: 1, hospitals: [] },
    selectedId: null,
    // Elke filter is een lijst; leeg betekent geen beperking, dezelfde
    // betekenis als een leeg bereik op een gebruiker. derived is er één van
    // twee vragen over de opvolging en sluit zichzelf uit.
    filter: { statuses: [], products: [], countries: [], owners: [], derived: "", query: "" },
    // Van welk ziekenhuis de lijst contactmomenten helemaal openstaat. Eén id
    // en geen vlag: zo klapt ze vanzelf weer dicht bij een ander ziekenhuis.
    actsOpen: null,
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
    // Welke maand de agenda toont, en eventueel één gekozen dag.
    // tab: "planned" is de agenda zelf, "log" het logboek ernaast.
    agenda: { y: new Date().getFullYear(), m: new Date().getMonth(), day: "", tab: "planned" },
    // Het logboek: alle contactmomenten over de ziekenhuizen heen. Product,
    // land, verantwoordelijke en de zoekterm deelt het met de kaart
    // (state.filter); dit zijn de keuzes die alleen hier bestaan. hospitalId
    // is gezet als je vanuit een fiche komt.
    log: { period: "quarter", types: [], authors: [], hospitalId: "", limit: 50 },
  };
  const markers = new Map();
  const store = window.FollowUpStore;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- helpers ----------
  const uid = () => Math.random().toString(16).slice(2, 12);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString(I18N.locale, { day: "2-digit", month: "short", year: "numeric" }) : t("rel.none");
  const daysAgo = (d) => Math.round((new Date(today()) - new Date(d)) / 86400000);
  const byId = (id) => state.db.hospitals.find((h) => h.id === id);
  const sel = () => byId(state.selectedId);
  const num = (v) => (v === "" || v == null ? null : Number(v));
  // Data uit een back-up of uit de online databank kan alles bevatten: deze
  // vier brengen een waarde terug tot het type dat de rest van de app verwacht.
  const str = (v) => (v == null ? "" : String(v));
  const numOrNull = (v) => {
    const n = Number(v);
    return v === "" || v == null || !Number.isFinite(n) ? null : n;
  };
  const dateOrEmpty = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : "");
  const coord = (v, max) => {
    const n = numOrNull(v);
    return n == null || Math.abs(n) > max ? null : n;
  };

  function lastContact(h) {
    return h.activities.reduce((max, a) => (a.date > max ? a.date : max), "");
  }
  function countType(h, type) {
    return h.activities.filter((a) => a.type === type).length;
  }
  // Hoort dit contactmoment of geplande moment bij de producten waarop
  // gefilterd is? Zonder filter alles; een record zonder product hoort overal
  // bij, zoals het ook voor iedereen zichtbaar is.
  const inFilter = (r) => !state.filter.products.length || !r.product || state.filter.products.includes(r.product);
  // "Te laat", "stil gevallen" en "demo gepland" volgen de productfilter, net
  // als de kleur: wie op Thyroid RFA filtert wil niet de achterstallige actie
  // van EndoQ zien. planned staat op datum, dus het eerste dat past is de
  // volgende actie — zonder filter is dat gewoon nextActionDate.
  function isOverdue(h) {
    const p = h.planned.find(inFilter);
    return !!p && p.date < today();
  }
  // Stil gevallen: er is contact geweest, er staat niets gepland en het laatste
  // contactmoment is lang geleden. Zo'n ziekenhuis glipt door alle andere
  // filters — niet rood (er was contact), niet groen (er staat niets), niet
  // "actie te laat" (er staat geen actie om te laat mee te zijn) en het duikt
  // nergens in de agenda op. Precies het ziekenhuis dat je wil terugvinden.
  const QUIET_DAYS = 90;
  function isQuiet(h) {
    if (h.planned.some(inFilter)) return false;
    const lc = h.activities.filter(inFilter).reduce((max, a) => (a.date > max ? a.date : max), "");
    return !!lc && daysAgo(lc) >= QUIET_DAYS;
  }
  // Een datum als YYYY-MM-DD uit de losse delen. Niet via toISOString(): die
  // rekent in UTC en schuift bij ons 's avonds een dag op.
  const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // nextAction en nextActionDate volgen uit het eerste geplande moment. Zo
  // blijven de lijst, de filter "actie te laat" en de CSV werken zoals
  // voorheen, zonder tweede plaats waar hetzelfde wordt bijgehouden.
  function syncNextAction(h) {
    const p = h.planned[0];
    h.nextActionDate = p ? p.date : "";
    h.nextAction = p ? p.note : "";
  }
  // Een demo die nog moet komen. Vroeger was dit het losse veld demoDate; nu
  // staat het gewoon in de agenda, zodat de teller en de agenda hetzelfde zien.
  function hasDemoPlanned(h) {
    const d = today();
    return h.planned.some((p) => p.type === "demo" && p.date >= d && inFilter(p));
  }
  function relDays(d) {
    if (!d) return "";
    const n = daysAgo(d);
    if (n === 0) return t("rel.today");
    if (n === 1) return t("rel.yesterday");
    if (n < 0) return t("rel.inDays", { n: -n });
    return t("rel.daysAgo", { n });
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- opslag ----------
  let saveTimer = null;
  // Of er nog iets te bewaren is, houden we zelf bij. Eerder werd daarvoor de
  // tekst op het scherm vergeleken met t("save.saved") — na een taalwissel
  // klopte die vergelijking niet meer en waarschuwde de browser altijd.
  let dirty = false;
  let saveState = { key: "", error: false };
  function showSaveState(key, error = false) {
    saveState = { key, error };
    const el = $("#saveState");
    el.textContent = key ? t(key) : "";
    el.classList.toggle("error", error);
    // Het vinkje ervoor tekent styles.css, op deze toestand; de uitleg staat
    // in de tooltip, want "Opgeslagen" alleen zegt niet wát.
    el.dataset.state = key.replace("save.", "");
    el.title = key === "save.saved" ? t("save.savedTitle") : "";
  }
  function scheduleSave() {
    // Vangnet achter de knoppen. Een rol zonder schrijfrecht komt hier niet
    // door, ook niet langs een weg die we vergaten te verbergen. De databank
    // weigert het trouwens ook — dit is er alleen om het meteen te zeggen in
    // plaats van na een mislukte opslag.
    if (!store.can.write) { toast(t("rights.readOnly")); return; }
    dirty = true;
    showSaveState("save.saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  // "import" geldt voor één opslag: de eerstvolgende. Daarna weer gewoon.
  let saveMode = "save";
  async function save() {
    const mode = saveMode;
    saveMode = "save";
    try {
      await store.save(state.db, mode);
      dirty = false;
      showSaveState("save.saved");
    } catch (e) {
      showSaveState("save.failed", true);
      if (e instanceof store.ConflictError) {
        showBanner(t("save.conflict"), true);
      } else {
        const hint = store.mode === "local" ? t("save.errorLocal") : t("save.errorOnline");
        showBanner(t("save.errorBody", { hint, msg: e.message }));
      }
    }
  }
  window.addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  // Een tekstvak drukt alleen af wat in het kadertje past; de rest valt weg,
  // en net in de notities staat waarom een ziekenhuis ligt zoals het ligt.
  // Vlak voor het afdrukken rekken we het vak op tot de inhoud en daarna weer
  // terug. Niet elke browser stuurt beforeprint, vandaar ook de mediaquery.
  function fitTextareasForPrint(on) {
    document.querySelectorAll("textarea").forEach((ta) => {
      ta.style.height = on ? ta.scrollHeight + "px" : "";
    });
  }
  window.addEventListener("beforeprint", () => fitTextareasForPrint(true));
  window.addEventListener("afterprint", () => fitTextareasForPrint(false));
  const printMedia = window.matchMedia("print");
  if (printMedia.addEventListener) {
    printMedia.addEventListener("change", (e) => fitTextareasForPrint(e.matches));
  }
  function showBanner(msg, reload = false) {
    const b = $("#banner");
    b.textContent = msg;
    if (reload) {
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = t("btn.reload");
      btn.style.marginLeft = "10px";
      btn.onclick = () => location.reload();
      b.append(btn);
    }
    b.hidden = !msg;
  }

  // ---------- rechten ----------
  // Welke knoppen verdwijnen, bepaalt styles.css aan de hand van dit attribuut.
  // Eén keer zetten is genoeg: het staat op body en overleeft dus elke render,
  // terwijl een JS-pass na iedere innerHTML opnieuw zou moeten lopen.
  function applyRights() {
    const can = store.can;
    const flags = [];
    if (!can.write) flags.push("no-write");
    if (!can.remove) flags.push("no-delete");
    if (!can.importData) flags.push("no-import");
    document.body.dataset.rights = flags.join(" ");
    $("#usersBtn").hidden = !can.manageUsers;
    // Zonder profiel valt iedereen terug op "alleen lezen". Dat is veilig, maar
    // zonder uitleg lijkt het op een storing: zeg dus wat eraan hapert.
    if (can.noProfile) showBanner(t("rights.noProfile"));
    // De productfilter biedt enkel aan wat je mag zien; renderFilters() leest
    // myProducts(). Stond er nog iets aangevinkt dat nu buiten bereik valt,
    // dan zou de lijst leeg blijven zonder dat je ziet waarom.
    if (can.products.length) {
      state.filter.products = state.filter.products.filter((p) => can.products.includes(p));
    }
    renderFilters();
  }
  // Knoppen weghalen kan met CSS, een invulveld op slot zetten niet. Dit loopt
  // na elke render van de fiche, want dan is de opmaak net vervangen.
  function lockFields(root) {
    if (store.can.write || !root) return;
    root.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") el.disabled = true;
      else el.readOnly = true;
    });
  }

  // Oudere of ingevoerde data kan velden missen of een verkeerd type hebben.
  // Alles wordt hier naar de verwachte vorm gebracht, zodat de rest van de app
  // mag rekenen op strings, getallen en lijsten. Status, fase, land, sector en
  // het type contactmoment zijn vaste sleutels: iets anders vervangen we door
  // de standaardwaarde — zo komt er ook nooit opmaak of script in de data.
  // Nieuw veld toegevoegd? Vul het hier aan, anders breekt oudere data.

  // Wat geen object is, is geen record: zulke rommel valt eruit voordat er
  // genormaliseerd wordt. Anders struikelt normalize halverwege en rendert de
  // app op halve data in plaats van de melding te laten zien.
  const records = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

  // ---------- wie heeft dit ingevoerd ----------
  // Let op het verschil: date is wanneer het contactmoment gebeurde,
  // createdAt is wanneer iemand het in de app heeft gezet. Dat is niet
  // hetzelfde — een bezoek van vorige week voer je vandaag in.
  //
  // Oudere records hebben niets van dit alles. Die krijgen hier een lege
  // string, en overal waar we een naam tonen betekent leeg: niets tonen. Beter
  // geen naam dan een verzonnen naam.
  function stampFields(rec) {
    rec.createdBy = str(rec.createdBy);
    rec.createdAt = dateOrEmpty(rec.createdAt);
    rec.updatedBy = str(rec.updatedBy);
    rec.updatedAt = dateOrEmpty(rec.updatedAt);
    return rec;
  }
  function stamp(rec, isNew) {
    const id = store.me().id;
    if (isNew) { rec.createdBy = id; rec.createdAt = today(); }
    rec.updatedBy = id;
    rec.updatedAt = today();
    return rec;
  }
  // Namen bij de uuid's uit app_users, één keer opgehaald bij het starten.
  const people = new Map();
  async function loadPeople() {
    try {
      for (const u of await store.users()) if (u.name) people.set(u.id, u.name);
    } catch (e) {
      // Geen lijst (lokaal, of het schema is nog niet uitgevoerd): dan tonen we
      // gewoon geen namen. Dat is geen reden om de app te laten struikelen.
    }
  }
  function personName(id) {
    if (!id) return "";
    // Jezelf kennen we ook zonder de lijst — lokaal is er zelfs geen lijst.
    if (id === store.me().id) return store.me().name;
    return people.get(id) || "";
  }
  // De regel onderaan een dialoog. Is er niets bekend, dan staat er niets.
  function stampLine(rec) {
    if (!rec) return "";
    const lines = [];
    if (rec.createdAt) {
      const by = personName(rec.createdBy);
      lines.push(by ? t("stamp.created", { name: by, date: fmtDate(rec.createdAt) })
                    : t("stamp.createdOn", { date: fmtDate(rec.createdAt) }));
    }
    // Ook tonen als iemand anders eraan zat op dezelfde dag: we bewaren een
    // datum en geen tijdstip, dus op de datum alleen zou dat onzichtbaar zijn.
    if (rec.updatedAt && (rec.updatedAt !== rec.createdAt || rec.updatedBy !== rec.createdBy)) {
      const by = personName(rec.updatedBy);
      lines.push(by ? t("stamp.updated", { name: by, date: fmtDate(rec.updatedAt) })
                    : t("stamp.updatedOn", { date: fmtDate(rec.updatedAt) }));
    }
    return lines.length ? `<p class="muted stamp">${esc(lines.join(" · "))}</p>` : "";
  }
  function normalizeContact(c) {
    c.id = str(c.id) || uid();
    for (const k of ["name", "role", "phone", "email", "address", "notes"]) c[k] = str(c[k]);
    // Een contactpersoon droeg één product. Dat bleek te krap: dezelfde arts is
    // vaak het aanspreekpunt voor allebei, en met een derde product erbij wordt
    // dat alleen maar vaker zo. Het oude veld wordt hier omgezet en verdwijnt,
    // zoals demoDate destijds in planned[] is opgegaan.
    if (!Array.isArray(c.products)) c.products = str(c.product) ? [str(c.product)] : [];
    delete c.product;
    c.products = [...new Set(c.products.filter((p) => typeof p === "string" && p))];
    // De dienst is een vaste sleutel; de functie ernaast blijft vrije tekst.
    c.department = DEPARTMENTS.includes(c.department) ? c.department : "";
    c.language = LANGUAGES.includes(c.language) ? c.language : "";
    c.primary = !!c.primary;
    return c;
  }
  function normalizeActivity(a) {
    a.id = str(a.id) || uid();
    a.type = ACT_TYPE_KEYS.includes(a.type) ? a.type : "other";
    a.date = dateOrEmpty(a.date);
    a.product = str(a.product);
    a.contactId = str(a.contactId);
    a.note = str(a.note);
    a.rooms = wantsQuantity(a.type, a.product) ? numOrNull(a.rooms) : null;
    stampFields(a);
    return a;
  }
  // Een gepland moment is géén contactmoment: het staat apart en raakt de
  // kleur, de fase en de statistieken niet. Een aantal kamers hoort bij wat
  // echt gebeurd is, dus dat vragen we pas bij het afvinken.
  function normalizePlanned(p) {
    p.id = str(p.id) || uid();
    p.type = ACT_TYPE_KEYS.includes(p.type) ? p.type : "other";
    p.date = dateOrEmpty(p.date);
    p.product = str(p.product);
    p.contactId = str(p.contactId);
    p.note = str(p.note);
    stampFields(p);
    return p;
  }
  // De gegevens van een product per ingreep. Ze staan in de rij van dat
  // product in h.pipeline en niet in een blok op het ziekenhuis zoals unit:
  // Thyroid RFA en Fibroid RFA hebben elk hun eigen goedkeuring, prioriteit en
  // concurrent in hetzelfde ziekenhuis, en zo vallen ze vanzelf binnen de
  // productmuur — de databank schermt die rijen al af per product.
  function normalizeFacts(e) {
    e.cmm = CMM_STATES.includes(e.cmm) ? e.cmm : "";
    e.prio = [1, 2, 3].includes(Number(e.prio)) ? Number(e.prio) : null;
    e.doesAlready = YES_NO.includes(e.doesAlready) ? e.doesAlready : "";
    e.currentSystem = str(e.currentSystem);
    e.notes = str(e.notes);
    return e;
  }
  // De opvolging per product. Elk product dat bij het ziekenhuis aangevinkt
  // staat krijgt een eigen fase, kleur en verantwoordelijke; wat op het
  // ziekenhuis zelf staat volgt daaruit (zie pipelineView in domain.js).
  //
  // Vroeger was er één fase per ziekenhuis. Die wordt hier de fase van elk
  // product dat er toen aangevinkt stond — de app wist niet beter, en twee
  // keer dezelfde fase is juister dan één van de twee op prospect zetten. Een
  // product dat er láter bijkomt begint vooraan: prospect, of eerste contact
  // als er al een contactmoment voor bestaat.
  //
  // Een rij verdwijnt hier nooit, ook niet als het vinkje weggaat. Wie
  // afgeschermd is krijgt h.products gesnoeid op zijn eigen bereik, en zou
  // anders de opvolging van een collega wissen bij de eerste opslag.
  function syncPipeline(h) {
    if (!h.pipeline || typeof h.pipeline !== "object" || Array.isArray(h.pipeline)) h.pipeline = {};
    for (const [p, e] of Object.entries(h.pipeline)) {
      if (!e || typeof e !== "object") { delete h.pipeline[p]; continue; }
      e.stage = STAGES.includes(e.stage) ? e.stage : "prospect";
      e.status = STATUSES.includes(e.status) ? e.status : "red";
      e.owner = str(e.owner);
      if (productKind(p) === "procedure") normalizeFacts(e);
    }
    const eerste = !Object.keys(h.pipeline).length;
    for (const p of h.products) {
      if (h.pipeline[p]) continue;
      const contacted = h.activities.some((a) => a.product === p);
      const e = eerste ? { stage: h.stage, status: h.status, owner: "" }
        : { stage: contacted ? "first_contact" : "prospect", status: contacted ? "orange" : "red", owner: "" };
      // Een fase die dit product niet kent, schuift naar de dichtste die het
      // wel kent: allebei liggen ze net voor of net na de evaluatie.
      if (!stagesFor(p).includes(e.stage)) e.stage = "evaluation";
      if (productKind(p) === "procedure") normalizeFacts(e);
      h.pipeline[p] = e;
    }
    if (h.products.length) {
      const f = furthest(h.products.map((p) => h.pipeline[p]));
      h.status = f.status;
      h.stage = f.stage;
    } else if (!stagesFor("").includes(h.stage)) {
      // Zonder product geldt de keuzelijst van het ziekenhuis zelf, en die
      // kent niet elke fase.
      h.stage = "evaluation";
    }
  }
  // Het laatste product is afgevinkt. De kleur en de fase op het ziekenhuis
  // waren die van dat product; ze laten staan zou zeggen dat een ziekenhuis
  // zonder product klant is. Terug naar wat de contactmomenten zeggen. Wat er
  // per product stond blijft bewaard en komt terug als het vinkje terugkomt.
  function zonderProduct(h) {
    if (h.products.length) return;
    const contacted = h.activities.length > 0;
    h.status = contacted ? "orange" : "red";
    h.stage = contacted ? "first_contact" : "prospect";
  }
  // Wat de kaart, de lijst en de tellers van een ziekenhuis tonen: het volgt
  // de productfilter in de zijbalk.
  const shown = (h) => pipelineView(h, state.filter.products);
  // De regel onder een contactmoment of een gepland moment: product,
  // contactpersoon, aantal, en wie het invoerde. De fiche, de agenda en het
  // logboek tonen alle drie dezelfde; met type erbij waar de soort niet al
  // apart boven de regel staat. Een gepland moment heeft geen aantal, dus dat
  // valt daar vanzelf weg.
  function momentLine(h, r, withType) {
    const c = h.contacts.find((x) => x.id === r.contactId);
    const by = personName(r.createdBy);
    return [withType && t("act." + r.type), r.product, c && c.name,
      r.rooms ? `${r.rooms} ${t(productKind(r.product) === "procedure" ? "act.units" : "act.rooms")}` : "",
      by && t("by", { name: by })].filter(Boolean).join(" · ");
  }
  // De contactmomenten als CSV, recentste eerst: voor de export van alles en
  // voor "CSV van deze keuze" in het logboek.
  function activitiesCsv(items) {
    return csv([
      [t("col.date"), t("col.hospital"), t("col.type"), t("col.product"), t("col.contact"), t("col.quantity"), t("col.note"), t("col.addedBy")],
      ...[...items].sort((x, y) => y.a.date.localeCompare(x.a.date))
        .map(({ h, a }) => [a.date, h.name, t("act." + a.type), a.product,
          (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.rooms ?? "", a.note, personName(a.createdBy)]),
    ]);
  }
  // Zoveel contactmomenten toont de fiche standaard, de recentste eerst. Wie
  // ze allemaal wil zien klapt de lijst open. Dit gaat enkel over tonen:
  // activities[] blijft volledig, en daar rekenen de kleur, de fase en de
  // statistieken op.
  const ACT_CAP = 5;
  // De endoscopie-afdeling — scopes, torens, kamers, coloscopieën — beschrijft
  // waar een product per abonnement op aangesloten wordt. Voor een ziekenhuis
  // dat enkel voor RFA gevolgd wordt zegt ze niets, en voor wie enkel RFA mag
  // evenmin. Twee vragen dus: heeft dit account zo'n product, en hangt er een
  // aan dit ziekenhuis. De regel is "een product per abonnement", niet twee
  // namen, zodat een vijfde product vanzelf aan de juiste kant valt.
  //
  // Dit is tonen of niet tonen, geen muur: unit is een gedeeld veld van het
  // ziekenhuis en bereikt de browser nog altijd. Moet dat niet, dan is dat
  // werk voor scope_hospital() in schema.sql.
  const endoAccount = () => myProducts().some((p) => productKind(p) === "subscription");
  const endoFor = (h) => myProducts().some((p) => productKind(p) === "subscription" && h.products.includes(p));
  // Wie verantwoordelijk kan zijn: iedereen met een account, op naam. Eén
  // lijst voor de keuzelijst in de fiche en voor de filter in de zijbalk.
  function owners() {
    const list = new Map(people);
    const me = store.me();
    if (me.id && me.name) list.set(me.id, me.name);
    return [...list].sort((a, b) => a[1].localeCompare(b[1]));
  }
  // Een id dat we niet (meer) kennen blijft als keuze staan, anders wist een
  // opslag het.
  function ownerOptions(current) {
    const list = owners();
    if (current && !list.some(([id]) => id === current)) list.push([current, "?"]);
    return [opt("", "—", current), ...list.map(([id, name]) => opt(id, name, current))].join("");
  }

  function normalize(h) {
    h.id = str(h.id) || uid();
    h.name = str(h.name).trim() || "—";
    h.contacts = records(h.contacts);
    h.activities = records(h.activities);
    if (!Array.isArray(h.products)) h.products = [];
    h.contacts.forEach(normalizeContact);
    h.activities.forEach(normalizeActivity);
    h.products = h.products.filter((p) => typeof p === "string");
    h.status = STATUSES.includes(h.status) ? h.status : "red";
    h.stage = STAGES.includes(h.stage) ? h.stage : "prospect";
    syncPipeline(h);
    h.country = COUNTRIES.includes(h.country) ? h.country : "";
    h.sector = SECTORS.includes(h.sector) ? h.sector : "";
    h.address = str(h.address);
    h.network = str(h.network);
    h.sites = str(h.sites);
    h.notes = str(h.notes);
    h.nextAction = str(h.nextAction);
    h.nextActionDate = dateOrEmpty(h.nextActionDate);
    h.planned = records(h.planned);
    h.planned.forEach(normalizePlanned);
    // Vroeger was er één volgende actie per ziekenhuis: tekst en datum apart,
    // en de tekst mocht er staan zonder datum. Allebei worden ze hier het
    // eerste geplande moment. Staat er geen datum bij, dan zetten we die op
    // vandaag: zo duikt de tekst op in de agenda in plaats van te verdwijnen,
    // want hieronder vallen momenten zonder datum weg. Daarna is h.planned
    // gevuld en gebeurt dit niet nog een keer.
    if (!h.planned.length && (h.nextActionDate || h.nextAction)) {
      h.planned.push(normalizePlanned({
        date: h.nextActionDate || today(), type: "other", note: h.nextAction,
      }));
    }
    // "Demo gepland op" was een los datumveld van vóór planned[]. Het stond niet
    // in de agenda, werd bij het afvinken niet leeggemaakt en bleef dus staan
    // lang nadat de demo was geweest. De datum wordt hier een gepland moment,
    // tenzij er die dag al een demo staat. Daarna is het veld weg en gebeurt
    // dit niet nog een keer.
    const demo = dateOrEmpty(h.demoDate);
    if (demo && !h.planned.some((p) => p.type === "demo" && p.date === demo)) {
      h.planned.push(normalizePlanned({ date: demo, type: "demo" }));
    }
    delete h.demoDate;
    // Zonder datum is het geen planning, en de agenda rekent op de sortering.
    h.planned = h.planned.filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date));
    syncNextAction(h);
    h.createdAt = dateOrEmpty(h.createdAt) || today();
    // Een halve locatie is geen locatie: de kaart rekent op lat én lng.
    h.lat = coord(h.lat, 90);
    h.lng = coord(h.lng, 180);
    if (h.lat == null || h.lng == null) { h.lat = null; h.lng = null; }
    if (!h.unit || typeof h.unit !== "object" || Array.isArray(h.unit)) h.unit = {};
    // Vroeger bewaarde de app hier de getoonde tekst; nu de sleutel.
    const brands = (v) => (Array.isArray(v)
      ? v.filter((b) => typeof b === "string").map((b) => (b === "Andere / Other" ? "other" : b))
      : []);
    h.unit.scopeBrands = brands(h.unit.scopeBrands);
    h.unit.processorBrands = brands(h.unit.processorBrands);
    for (const k of ["rooms", "roomsDemo", "roomsInstalled", "colosPerYear"]) h.unit[k] = numOrNull(h.unit[k]);
    h.unit.scopeNotes = str(h.unit.scopeNotes);
    h.unit.processorNotes = str(h.unit.processorNotes);
    h.unit.existingAI = str(h.unit.existingAI);
    h.unit.screening = !!h.unit.screening;
    return h;
  }

  // ---------- kaart ----------
  const map = L.map("map", { zoomControl: true }).fitBounds(REGION_BOUNDS);
  // Zonder {s}: de subdomeinen a/b/c zijn de oude vorm en openen drie
  // verbindingen waar één volstaat. OpenStreetMap blokkeert daarop, en dan
  // staat de kaart vol "Access blocked"-tegels. Zet je de subdomeinen terug,
  // pas dan ook img-src in index.html aan: *.tile.openstreetmap.org en de
  // kale hostnaam dekken elkaar niet.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  function pinIcon(h) {
    const cls = ["pin", shown(h).status, h.id === state.selectedId ? "selected" : "", h.id === state.dragId ? "dragging" : ""].join(" ");
    return L.divIcon({ className: "", html: `<div class="${esc(cls)}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function renderMarkers() {
    markers.forEach((m) => m.remove());
    markers.clear();
    for (const h of visibleHospitals()) {
      if (h.lat == null || h.lng == null) continue;
      const m = L.marker([h.lat, h.lng], { icon: pinIcon(h), draggable: h.id === state.dragId, zIndexOffset: h.id === state.selectedId ? 1000 : 0 })
        .addTo(map)
        .bindTooltip(esc(h.name), { direction: "top", offset: [0, -10], className: "pin-label" })
        .on("click", () => select(h.id, false));
      m.on("dragend", () => {
        const p = m.getLatLng();
        h.lat = +p.lat.toFixed(5);
        h.lng = +p.lng.toFixed(5);
        scheduleSave();
        toast(t("map.locationUpdated"));
      });
      markers.set(h.id, m);
    }
  }

  // De kaart kan gebouwd zijn toen de container nog geen grootte had (eerste
  // paint, verborgen tabblad, gsm achter de tabbalk). Dan wachten we met
  // inzoomen tot ze er wel een heeft, anders blijft de wereldkaart staan.
  let fitObserver = null;
  function fitAll() {
    const el = map.getContainer();
    if (!el.offsetWidth) {
      state.pendingFit = true;
      if (!fitObserver && window.ResizeObserver) {
        fitObserver = new ResizeObserver(() => {
          if (!el.offsetWidth) return;
          fitObserver.disconnect();
          fitObserver = null;
          if (state.pendingFit) { state.pendingFit = false; fitAll(); }
        });
        fitObserver.observe(el);
      }
      return;
    }
    state.pendingFit = false;
    map.invalidateSize();
    const pts = visibleHospitals().filter((h) => h.lat != null).map((h) => [h.lat, h.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
  }

  map.on("click", (e) => {
    if (!state.placing) return;
    const h = byId(state.placing.id);
    state.placing = null;
    $("#placeHint").hidden = true;
    map.getContainer().style.cursor = "";
    if (!h) return;
    h.lat = +e.latlng.lat.toFixed(5);
    h.lng = +e.latlng.lng.toFixed(5);
    state.ficheOpen = true;
    scheduleSave();
    renderAll();
    toast(t("map.locationSet"));
  });
  function startPlacing(id) {
    state.placing = { id };
    state.ficheOpen = false;
    setView("map");
    renderFiche();
    $("#placeHint").hidden = false;
    map.getContainer().style.cursor = "crosshair";
  }
  $("#cancelPlace").addEventListener("click", () => {
    state.placing = null;
    $("#placeHint").hidden = true;
    map.getContainer().style.cursor = "";
  });
  $("#fitBtn").addEventListener("click", fitAll);
  $("#regionBtn").addEventListener("click", () => map.fitBounds(REGION_BOUNDS));

  // ---------- filter + lijst ----------
  function matchesQuery(h, q) {
    if (!q) return true;
    // De nota's van de endoscopie-afdeling alleen voor wie die afdeling ook te
    // zien krijgt: anders vind je een ziekenhuis op tekst die nergens staat.
    const unit = endoAccount() ? [h.unit.scopeNotes, h.unit.processorNotes, h.unit.existingAI] : [];
    const hay = [h.name, h.address, h.network, h.sites, ...unit, h.notes,
      ...h.contacts.flatMap((c) => [c.name, c.role, c.address, c.email, c.department && t("dept." + c.department)])]
      .join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }
  // De twee vragen over de opvolging. Ze filteren niet op een merk maar op het
  // verloop, en ze hebben daarom een eigen rij en een eigen sleutel in
  // state.filter in plaats van tussen de producten te zitten — zo is er ook
  // geen naam die met een product kan botsen.
  const DERIVED_FILTERS = { overdue: isOverdue, quiet: isQuiet };
  // De verantwoordelijken van een ziekenhuis, voor de producten waarop
  // gefilterd is — of voor al zijn producten als er geen productfilter staat.
  const ownersOf = (h) => h.products
    .filter((p) => (!state.filter.products.length || state.filter.products.includes(p)) && h.pipeline[p])
    .map((p) => h.pipeline[p].owner).filter(Boolean);
  // Waar je naar kijkt: product, land en verantwoordelijke. Dat is ook waar de
  // tellers bovenaan over gaan. De andere filters (kleur, te laat, stil
  // gevallen, de zoekbalk) zoeken daarbinnen — telden de tellers die ook mee,
  // dan stond er bij een filter op groen gewoon overal nul naast.
  function scopedHospitals() {
    const { products, countries, owners } = state.filter;
    return state.db.hospitals.filter((h) =>
      (!products.length || products.some((p) => h.products.includes(p))) &&
      (!countries.length || countries.includes(h.country)) &&
      (!owners.length || ownersOf(h).some((o) => owners.includes(o))));
  }
  function visibleHospitals() {
    const { statuses, derived, query } = state.filter;
    return scopedHospitals().filter((h) =>
      (!statuses.length || statuses.includes(shown(h).status)) &&
      (!derived || DERIVED_FILTERS[derived](h)) &&
      matchesQuery(h, query));
  }

  function renderList() {
    const order = { green: 0, orange: 1, red: 2 };
    const q = state.filter.query.toLowerCase();
    const nameHit = (h) => (q && h.name.toLowerCase().includes(q) ? 0 : 1);
    const items = visibleHospitals().sort((a, b) =>
      nameHit(a) - nameHit(b) || order[shown(a).status] - order[shown(b).status] || a.name.localeCompare(b.name));
    const ul = $("#list");
    ul.removeAttribute("aria-busy"); // de streepjes van het laden gaan eruit
    if (!items.length) {
      ul.innerHTML = `<li class="empty">${esc(t("list.empty"))}</li>`;
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      const primary = h.contacts.find((c) => c.primary);
      const bits = [t("stage." + shown(h).stage)];
      if (h.country) bits.push(t("country." + h.country + ".short"));
      if (h.unit.roomsInstalled && endoAccount()) bits.push(`${h.unit.roomsInstalled}× ${t("stats.roomsLive").toLowerCase()}`);
      const chosen = h.id === state.selectedId;
      return `<li data-id="${esc(h.id)}" class="${chosen ? "selected" : ""}" tabindex="0"${chosen ? ' aria-current="true"' : ""}>
        <i class="dot ${esc(shown(h).status)}"></i>
        <div>
          ${lc ? `<span class="age" title="${esc(t("rel.last") + " " + relDays(lc))}">${esc(daysAgo(lc) > 0 ? t("rel.short", { n: daysAgo(lc) }) : relDays(lc))}</span>` : ""}
          <div class="name">${esc(h.name)}${isOverdue(h) ? `<span class="badge">${esc(t("badge.overdue"))}</span>` : ""}${isQuiet(h) ? `<span class="badge quiet">${esc(t("badge.quiet"))}</span>` : ""}${h.lat == null ? `<span class="badge neutral">${esc(t("map.noLocation"))}</span>` : ""}</div>
          <div class="meta">${esc(bits.join(" · "))}</div>
          ${primary ? `<div class="meta lead">${icon("star", "fill")}${esc(primary.name)}</div>` : ""}
        </div>
      </li>`;
    }).join("");
  }
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id, true);
  });
  $("#list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    e.preventDefault();
    select(li.dataset.id, true);
  });

  // De drie filters in de zijbalk. Ze staan hier en niet in index.html omdat
  // de lijsten van de taal afhangen en de producten van je bereik.
  const FILTERS = [
    { key: "statuses",  leeg: "filter.allStatuses",        items: () => STATUSES,  label: (k) => t("status." + k + ".short") },
    { key: "products",  leeg: "filter.allProducts",  items: myProducts,      label: (p) => p },
    { key: "countries", leeg: "filter.allCountries", items: () => COUNTRIES, label: (c) => t("country." + c) },
    // Wie verantwoordelijk is. De lijst is die van de keuzelijst in de fiche:
    // iedereen met een account. Zonder namen (lokaal, zonder localUser) is er
    // niets om op te filteren en staat de uitklapper er niet.
    { key: "owners",    leeg: "filter.allOwners",    items: () => owners().map(([id]) => id), label: (id) => personName(id) },
  ];
  function renderDerived() {
    for (const b of $("#derivedFilters").querySelectorAll(".chip")) {
      b.classList.toggle("active", b.dataset.derived === state.filter.derived);
    }
  }
  function renderFilters() {
    $("#pickFilters").innerHTML = FILTERS.filter((f) => f.items().length).map((f) => pickBox(
      f.items().map((k) => ({
        attrs: `data-filter="${esc(f.key)}" data-value="${esc(k)}"`,
        label: f.label(k),
        checked: state.filter[f.key].includes(k),
      })), t(f.leeg))).join("");
    renderDerived();
  }
  // Niet hertekenen bij elk vinkje: dan klapt de uitklapper dicht. Enkel de
  // lijst en de kaart dus; de samenvatting op de knop is het werk van de
  // uitklapper zelf.
  $("#pickFilters").addEventListener("change", (e) => {
    const box = e.target.closest("[data-filter]");
    if (!box) return;
    const f = FILTERS.find((x) => x.key === box.dataset.filter);
    const v = box.dataset.value;
    state.filter[f.key] = e.target.checked
      ? [...state.filter[f.key], v]
      : state.filter[f.key].filter((x) => x !== v);
    renderList();
    renderMarkers();
    renderKpis();
  });
  // De twee opvolgingsknoppen. Nog eens klikken zet ze weer uit; ze sluiten
  // elkaar uit, want wie iets gepland heeft is nooit stilgevallen.
  $("#derivedFilters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.filter.derived = state.filter.derived === b.dataset.derived ? "" : b.dataset.derived;
    // Alleen de twee knoppen omschakelen; renderFilters() zou de drie
    // uitklappers ernaast nodeloos opnieuw opbouwen. Dat een open uitklapper
    // hierbij dichtgaat is iets anders en blijft: je klikte ernaast.
    renderDerived();
    renderList();
    renderMarkers();
  });

  // Even wachten met hertekenen: bij elke toetsaanslag alle markers van de
  // kaart halen en opnieuw zetten is zonde van het werk.
  let searchTimer = null;
  function applySearch() {
    clearTimeout(searchTimer);
    const q = $("#search").value.trim();
    if (q === state.filter.query) return;
    state.filter.query = q;
    renderList();
    renderMarkers();
  }
  $("#search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 120);
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applySearch(); // niet op de pauze wachten als je meteen Enter duwt
      const first = $("#list li[data-id]");
      if (first) select(first.dataset.id, true);
    }
  });

  function renderKpis() {
    // De tellers volgen product, land en verantwoordelijke (zie
    // scopedHospitals), met de kleur van het gefilterde product.
    const hs = scopedHospitals();
    const n = (s) => hs.filter((h) => shown(h).status === s).length;
    // Kamers zeggen niets als er enkel op producten per ingreep gefilterd is.
    const kamers = state.filter.products.length
      ? state.filter.products.some((p) => productKind(p) === "subscription")
      : endoAccount();
    const sum = (f) => hs.reduce((s, h) => s + (f(h) || 0), 0);
    const demos = hs.filter(hasDemoPlanned).length;
    const late = hs.filter(isOverdue).length;
    const quiet = hs.filter(isQuiet).length;
    $("#kpis").removeAttribute("aria-busy");
    $("#kpis").innerHTML = `
      <div class="kpi"><b><i class="dot green"></i>${n("green")}</b><span>${esc(t("status.green.short"))}</span></div>
      <div class="kpi"><b><i class="dot orange"></i>${n("orange")}</b><span>${esc(t("status.orange.short"))}</span></div>
      <div class="kpi"><b><i class="dot red"></i>${n("red")}</b><span>${esc(t("status.red.short"))}</span></div>
      <div class="kpi${late ? " alert" : ""}"><b>${late}</b><span>${esc(t("kpi.overdue"))}</span></div>
      <div class="kpi${quiet ? " warn" : ""}"><b>${quiet}</b><span>${esc(t("kpi.quiet"))}</span></div>
      <div class="kpi"><b>${demos}</b><span>${esc(t("kpi.demosPlanned"))}</span></div>
      ${kamers ? `<div class="kpi"><b>${sum((h) => h.unit.roomsDemo)}</b><span>${esc(t("kpi.roomsDemo"))}</span></div>
      <div class="kpi"><b>${sum((h) => h.unit.roomsInstalled)}</b><span>${esc(t("kpi.roomsInstalled"))}</span></div>` : ""}`;
  }

  // ---------- selectie ----------
  function select(id, fly) {
    // Een ander ziekenhuis begint weer met de korte lijst contactmomenten.
    if (id !== state.selectedId) state.actsOpen = null;
    state.selectedId = id;
    state.ficheOpen = true;
    if (state.dragId && state.dragId !== id) state.dragId = null;
    const h = sel();
    renderAll();
    if (fly && h) focusOn(h);
  }
  // Een verborgen kaart (gsm, ander tabblad) heeft geen grootte; dan pas inzoomen zodra ze zichtbaar is.
  function focusOn(h) {
    if (h.lat == null) return;
    if (map.getContainer().offsetWidth) {
      map.invalidateSize();
      map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
    } else {
      state.pendingFocus = [h.lat, h.lng];
    }
  }
  function closeFiche() {
    state.selectedId = null;
    state.ficheOpen = false;
    state.dragId = null;
    renderAll();
  }

  // ---------- fiche ----------
  const opt = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  // Eén product kiezen, in dezelfde uitklapper als overal elders. Radio's en
  // geen vinkjes: een contactmoment hoort bij één product. Omdat ze allemaal
  // name="product" dragen, komt de keuze via FormData binnen, en de
  // samenvatting houdt de uitklapper zelf bij — de dialoog hoeft er dus
  // helemaal niets voor te doen. Het streepje is een rij als alle andere, en
  // daarmee ook meteen de tekst die er staat als er niets gekozen is.
  const productOne = (chosen) => pickBox([
    { attrs: `name="product" value=""`, label: "—", checked: !chosen, type: "radio" },
    ...myProducts().map((p) => ({
      attrs: `name="product" value="${esc(p)}"`, label: p, checked: chosen === p, type: "radio",
    })),
  ], "—");
  // Twee afvinklijsten met dezelfde merken: de scopes en de videoprocessors.
  // Welke lijst
  // een vakje bijwerkt staat in data-brand-list.
  const brandToggles = (h, key, brands) => `<div class="toggles">${brands.map((b) =>
    `<label><input type="checkbox" data-brand="${esc(b)}" data-brand-list="${esc(key)}" ${h.unit[key].includes(b) ? "checked" : ""}>${esc(scopeLabel(b))}</label>`).join("")}</div>`;
  const numField = (h, key, label) => `<label class="field">${esc(label)}
      <input type="number" min="0" data-unit="${key}" value="${esc(h.unit[key] ?? "")}">
    </label>`;

  function renderFiche() {
    const el = $("#fiche");
    const h = sel();
    el.hidden = !h || !state.ficheOpen;
    if (!h) { el.innerHTML = ""; return; }

    const lc = lastContact(h);
    const contacts = [...h.contacts].sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
    const acts = [...h.activities].sort((a, b) => b.date.localeCompare(a.date));
    const late = isOverdue(h);
    // De producten waarvoor hier een opvolging te tonen valt: wat aangevinkt
    // staat, binnen je eigen bereik. Is dat er geen, dan blijft de ene fase en
    // de ene kleur van het ziekenhuis zelf staan, zoals vroeger.
    const pipe = myProducts().filter((p) => h.products.includes(p) && h.pipeline[p]);
    // Wie afgeschermd is, beslist enkel over zijn eigen product. De losse
    // kleur en fase van het ziekenhuis krijgt hij niet te bedienen: hangt er
    // een product van een collega aan, dan rekent de databank die zelf uit en
    // ging zijn klik verloren zonder dat hij het zag.
    const beperkt = store.can.products.length > 0;

    el.innerHTML = `
      <div class="fiche-head">
        <div class="row">
          <i class="dot ${esc(shown(h).status)}" style="width:14px;height:14px"></i>
          <input class="fiche-title" data-field="name" value="${esc(h.name)}" title="${esc(h.name)}" aria-label="${esc(t("fiche.name"))}">
          <button class="icon-btn show-on-map" data-act="show-map" title="${esc(t("map.showOnMap"))}" aria-label="${esc(t("map.showOnMap"))}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg></button>
          <button class="icon-btn" data-act="close" title="${esc(t("btn.close"))}" aria-label="${esc(t("btn.close"))}">${icon("close")}</button>
        </div>
        ${pipe.length || beperkt ? "" : `<div class="status-pick">
          ${STATUSES.map((k) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" title="${esc(t("status." + k))}"><i class="dot ${k}"></i>${esc(t("status." + k + ".short"))}</button>`).join("")}
        </div>`}
      </div>

      <div class="section">
        <div class="stats">
          <div class="stat"><b>${esc(fmtDate(lc))}</b><span>${esc(t("fiche.lastContact"))} ${lc ? "· " + esc(relDays(lc)) : ""}</span></div>
          <div class="stat"><b>${countType(h, "demo")}</b><span>${esc(t("fiche.demos"))}</span></div>
          ${endoAccount() ? `<div class="stat"><b>${countType(h, "installation")}</b><span>${esc(t("fiche.installations"))}</span></div>
          <div class="stat"><b>${h.unit.roomsInstalled ?? "—"}</b><span>${esc(t("fiche.roomsLive"))}</span></div>` : ""}
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("section.followup"))}</h3>
        ${pipe.length ? pipe.map((p) => {
          const e = h.pipeline[p];
          return `<div class="pipe">
            <div class="pipe-head">
              <div class="pipe-name"><i class="dot ${esc(e.status)}"></i><b>${esc(p)}</b><span class="muted">${esc(t("status." + e.status + ".short"))}</span></div>
              <div class="status-pick">
                ${STATUSES.map((k) => `<button class="${k} ${e.status === k ? "active" : ""}" data-status="${k}" data-pproduct="${esc(p)}" title="${esc(t("status." + k))}"><i class="dot ${k}"></i>${esc(t("status." + k + ".short"))}</button>`).join("")}
              </div>
            </div>
            <div class="grid">
              <label class="field"><span class="lbl">${esc(t("field.stage"))}</span>
                <select data-pstage="${esc(p)}">${stagesFor(p).map((s) => opt(s, t("stage." + s), e.stage)).join("")}</select>
              </label>
              <label class="field"><span class="lbl">${esc(t("field.owner"))}</span>
                <select data-powner="${esc(p)}">${ownerOptions(e.owner)}</select>
              </label>
            </div>
          </div>`;
        }).join("") : beperkt ? `<p class="muted">${esc(t("fiche.tickProduct"))}</p>` : `<div class="grid">
          <label class="field">${esc(t("field.stage"))}
            <select data-field="stage">${stagesFor("").map((s) => opt(s, t("stage." + s), h.stage)).join("")}</select>
          </label>
        </div>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.planned"))}${late ? ` <span class="badge">${esc(t("badge.late"))}</span>` : ""} <button class="btn small" data-act="add-planned">${esc(t("btn.addPlanned"))}</button></h3>
        ${h.planned.length ? `<ul class="timeline">${h.planned.map((p) => {
          const c = h.contacts.find((x) => x.id === p.contactId);
          const by = personName(p.createdBy);
          const sub = [p.product, c && c.name, by && t("by", { name: by })].filter(Boolean).join(" · ");
          return `<li class="${p.date < today() ? "late" : ""}">
            <div class="t-date">${esc(fmtDate(p.date))}<span class="t-rel">${esc(relDays(p.date))}</span></div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill" style="background:${ACT_TYPES[p.type] || "#999"}"></span>${esc(t("act." + p.type))}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${p.note ? `<div class="t-note">${esc(p.note)}</div>` : ""}
            </div>
            <div class="t-acts">
              <button class="icon-btn" data-act="done-planned" data-id="${esc(p.id)}" title="${esc(t("btn.done.title"))}" aria-label="${esc(t("btn.done.title"))}">${icon("check")}</button>
              <button class="icon-btn" data-act="edit-planned" data-id="${esc(p.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
            </div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">${esc(t("empty.planned"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.activities"))} <button class="btn small" data-act="add-activity">${esc(t("btn.addActivity"))}</button></h3>
        ${acts.length ? `<ul class="timeline ${state.actsOpen === h.id ? "" : "capped"}">${acts.map((a, i) => {
          const sub = momentLine(h, a, false);
          return `<li${i >= ACT_CAP ? ' class="extra"' : ""}>
            <div class="t-date">${esc(fmtDate(a.date))}</div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill" style="background:${ACT_TYPES[a.type] || "#999"}"></span>${esc(t("act." + a.type))}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${a.note ? `<div class="t-note">${esc(a.note)}</div>` : ""}
            </div>
            <div><button class="icon-btn" data-act="edit-activity" data-id="${esc(a.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button></div>
          </li>`;
        }).join("")}</ul>${acts.length > ACT_CAP
          // Geen data-act: wat een rol niet mag wordt daarop verborgen, en
          // openklappen is lezen — dat mag ook wie alleen mag kijken.
          ? `<button class="btn small more-acts" data-acts-toggle>${esc(state.actsOpen === h.id ? t("acts.showLess") : t("acts.showAll", { n: acts.length }))}</button>` : ""}
          <button class="btn small more-acts" data-log-open>${esc(t("log.openHere"))}</button>`
          : `<p class="muted">${esc(t("empty.activities"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.contacts"))} <button class="btn small" data-act="add-contact">${esc(t("btn.addContact"))}</button></h3>
        ${contacts.length ? contacts.map((c) => `
          <div class="contact ${c.primary ? "primary" : ""}">
            <div class="c-actions">
              <button class="icon-btn" data-act="primary" data-id="${esc(c.id)}" title="${esc(t("dlg.c.primary"))}" aria-label="${esc(t("dlg.c.primary"))}" aria-pressed="${c.primary}">${icon("star", c.primary ? "fill" : "")}</button>
              <button class="icon-btn" data-act="edit-contact" data-id="${esc(c.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
            </div>
            <div class="c-name">${esc(c.name)}${c.department ? `<span class="tag dept">${esc(t("dept." + c.department))}</span>` : ""}${c.primary ? `<span class="tag primary">${esc(t("tag.primary"))}</span>` : ""}${c.language ? `<span class="tag dept">${esc(c.language)}</span>` : ""}${c.products.map((p) => `<span class="tag prod" style="--c:${productColor(p)}">${esc(p)}</span>`).join("")}</div>
            ${c.role ? `<div class="c-role">${esc(c.role)}</div>` : ""}
            ${c.phone ? `<div class="c-line">${icon("phone")}<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></div>` : ""}
            ${c.email ? `<div class="c-line">${icon("mail")}<a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
            ${c.address ? `<div class="c-line muted">${esc(c.address)}</div>` : ""}
            ${c.notes ? `<div class="c-line muted">${icon("note")}<span>${esc(c.notes)}</span></div>` : ""}
          </div>`).join("") : `<p class="muted">${esc(t("empty.contacts"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.data"))}</h3>
        <div class="grid">
          <label class="field">${esc(t("field.country"))}
            <select data-field="country">${[opt("", "—", h.country), ...COUNTRIES.map((c) => opt(c, t("country." + c), h.country))].join("")}</select>
          </label>
          <label class="field">${esc(t("field.sector"))}
            <select data-field="sector">${[opt("", "—", h.sector), ...SECTORS.map((s) => opt(s, t("sector." + s), h.sector))].join("")}</select>
          </label>
          <div class="field full"><span class="field-label">${esc(t("field.products"))}</span>
            <div class="toggles">${myProducts().map((p) => `<label><input type="checkbox" data-product="${esc(p)}" ${h.products.includes(p) ? "checked" : ""}>${esc(p)}</label>`).join("")}</div>
          </div>
          <label class="field full">${esc(t("field.address"))}
            <input data-field="address" value="${esc(h.address)}">
          </label>
          <label class="field">${esc(t("field.network"))}
            <input data-field="network" value="${esc(h.network)}">
          </label>
          <label class="field">${esc(t("field.sites"))}
            <input data-field="sites" value="${esc(h.sites)}">
          </label>
          <div class="field full">
            <span class="field-label">${esc(t("field.location"))}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">
              ${h.lat == null
                ? `<button class="btn small primary" data-act="place">${esc(t("btn.place"))}</button>`
                : `<button class="btn small ${state.dragId === h.id ? "primary" : ""}" data-act="drag">${esc(state.dragId === h.id ? t("btn.dragDone") : t("btn.drag"))}</button>
                   <button class="btn small" data-act="place">${esc(t("btn.placeNew"))}</button>`}
            </div>
          </div>
          <label class="field full">${esc(t("field.notes"))}
            <textarea data-field="notes" rows="4">${esc(h.notes)}</textarea>
          </label>
          <p class="muted full">${esc(t("field.createdAt"))}: ${esc(fmtDate(h.createdAt))}</p>
        </div>
      </div>

      ${pipe.filter((p) => productKind(p) === "procedure").map((p) => {
        // Eén sectie per product per ingreep, zoals de endoscopie-afdeling er
        // één is voor EndoQ en Ainex. Ze staat er alleen als het product bij
        // dit ziekenhuis aangevinkt is en binnen je bereik valt.
        const e = h.pipeline[p];
        const fact = (k) => `data-fact="${k}" data-fact-product="${esc(p)}"`;
        return `<div class="section">
        <h3>${esc(p)}</h3>
        <p class="muted">${esc(t("unit.unknownOk"))}</p>
        <div class="grid">
          <label class="field">${esc(t("rfa.cmm"))}
            <select ${fact("cmm")}>${[opt("", "—", e.cmm), ...CMM_STATES.map((k) => opt(k, t("rfa.cmm." + k), e.cmm))].join("")}</select>
          </label>
          <label class="field">${esc(t("rfa.prio"))}
            <select ${fact("prio")}>${[opt("", "—", String(e.prio ?? "")), ...[1, 2, 3].map((n) => opt(String(n), String(n), String(e.prio ?? "")))].join("")}</select>
          </label>
          <label class="field">${esc(t("rfa.doesAlready"))}
            <select ${fact("doesAlready")}>${[opt("", "—", e.doesAlready), ...YES_NO.map((k) => opt(k, t("yn." + k), e.doesAlready))].join("")}</select>
          </label>
          <label class="field">${esc(t("rfa.currentSystem"))}
            <input ${fact("currentSystem")} value="${esc(e.currentSystem)}" placeholder="${esc(t("rfa.currentSystem.ph"))}">
          </label>
          <label class="field full">${esc(t("rfa.notes"))}
            <textarea ${fact("notes")} rows="3">${esc(e.notes)}</textarea>
          </label>
        </div>
      </div>`;
      }).join("")}

      ${!endoFor(h) ? "" : `<div class="section">
        <h3>${esc(t("section.unit"))}</h3>
        <p class="muted">${esc(t("unit.unknownOk"))}</p>
        <div class="grid">
          <div class="field full"><span class="field-label">${esc(t("unit.scopeBrands"))}</span>
            ${brandToggles(h, "scopeBrands", SCOPE_BRANDS)}
          </div>
          <label class="field full">${esc(t("unit.scopeNotes"))}
            <input data-unit="scopeNotes" value="${esc(h.unit.scopeNotes)}" placeholder="${esc(t("unit.scopeNotes.ph"))}">
          </label>
          <div class="field full"><span class="field-label">${esc(t("unit.processorBrands"))}</span>
            ${brandToggles(h, "processorBrands", PROCESSOR_BRANDS)}
          </div>
          <label class="field full">${esc(t("unit.processorNotes"))}
            <input data-unit="processorNotes" value="${esc(h.unit.processorNotes)}" placeholder="${esc(t("unit.processorNotes.ph"))}">
          </label>
          ${numField(h, "rooms", t("unit.rooms"))}
          ${numField(h, "colosPerYear", t("unit.colosPerYear"))}
          ${numField(h, "roomsDemo", t("unit.roomsDemo"))}
          ${numField(h, "roomsInstalled", t("unit.roomsInstalled"))}
          <label class="field full">${esc(t("unit.existingAI"))}
            <input data-unit="existingAI" value="${esc(h.unit.existingAI)}" placeholder="${esc(t("unit.existingAI.ph"))}">
          </label>
          <label class="field full check"><input type="checkbox" data-unit-bool="screening" ${h.unit.screening ? "checked" : ""}>${esc(t("unit.screening"))}</label>
        </div>
      </div>`}

      <div class="fiche-foot">
        <button class="btn danger" data-act="delete">${esc(t("btn.delete"))}</button>
        <button class="btn" data-act="close">${esc(t("btn.close"))}</button>
      </div>`;
    attachAddressSearch(el.querySelector('[data-field="address"]'), (r) => {
      h.address = r.address;
      h.lat = r.lat;
      h.lng = r.lng;
      if (r.country && COUNTRIES.includes(r.country)) h.country = r.country;
      scheduleSave();
      renderAll();
      focusOn(h);
      toast(t("map.addressSet"));
    });
    lockFields(el);
  }

  // Velden in de fiche: opslaan zonder volledige herteken (focus blijft).
  $("#fiche").addEventListener("change", (e) => {
    const h = sel();
    if (!h) return;
    const el = e.target;
    const d = el.dataset;
    if (d.field) {
      h[d.field] = el.value;
      if (d.field === "name" && !el.value.trim()) { h.name = "—"; el.value = h.name; }
      if (d.field === "stage") stageStatus(h, h.activities.length > 0);
    } else if (d.pstage && h.pipeline[d.pstage]) {
      h.pipeline[d.pstage].stage = el.value;
      stageStatus(h.pipeline[d.pstage], h.activities.some((a) => a.product === d.pstage));
      syncPipeline(h);
    } else if (d.powner && h.pipeline[d.powner]) {
      h.pipeline[d.powner].owner = el.value;
    } else if (d.fact && h.pipeline[d.factProduct]) {
      // normalizeFacts houdt de vaste sleutels en het getal in de hand.
      h.pipeline[d.factProduct][d.fact] = el.value;
      normalizeFacts(h.pipeline[d.factProduct]);
    } else if (d.unit) {
      h.unit[d.unit] = el.type === "number" ? num(el.value) : el.value;
    } else if (d.unitBool) {
      h.unit[d.unitBool] = el.checked;
    } else if (d.brand) {
      const list = h.unit[d.brandList] || [];
      h.unit[d.brandList] = el.checked
        ? [...new Set([...list, d.brand])]
        : list.filter((x) => x !== d.brand);
    } else if (d.product) {
      h.products = el.checked ? [...new Set([...h.products, d.product])] : h.products.filter((x) => x !== d.product);
      if (!el.checked) zonderProduct(h);
      syncPipeline(h);
    } else return;
    scheduleSave();
    renderList();
    renderKpis();
    if (["name", "stage", "country"].includes(d.field) || d.pstage || d.product) { renderFiche(); renderMarkers(); }
  });

  $("#fiche").addEventListener("click", (e) => {
    const h = sel();
    if (!h) return;
    const sb = e.target.closest("[data-status]");
    if (sb) { setStatus(h, sb.dataset.status, sb.dataset.pproduct); return; }
    if (e.target.closest("[data-log-open]")) {
      return openLogFor(h);
    }
    if (e.target.closest("[data-acts-toggle]")) {
      state.actsOpen = state.actsOpen === h.id ? null : h.id;
      renderFiche();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "close": return closeFiche();
      case "show-map":
        state.ficheOpen = false;
        setView("map");
        renderAll();
        if (h.lat != null) state.pendingFocus = [h.lat, h.lng];
        else toast(t("map.noLocationYet"));
        return;
      case "add-contact": return contactDialog(h, null);
      case "edit-contact": return contactDialog(h, h.contacts.find((c) => c.id === id));
      case "primary": {
        const c = h.contacts.find((x) => x.id === id);
        const was = c.primary;
        h.contacts.forEach((x) => (x.primary = false));
        c.primary = !was;
        scheduleSave();
        return renderAll();
      }
      case "add-activity": return activityDialog(h, null);
      case "edit-activity": return activityDialog(h, h.activities.find((a) => a.id === id));
      case "add-planned": return plannedDialog(h, null);
      case "edit-planned": return plannedDialog(h, h.planned.find((p) => p.id === id));
      // Afvinken: het geplande moment wordt een contactmoment. De dialoog staat
      // al ingevuld; het aantal kamers vragen we daar voor het eerst.
      case "done-planned": return activityDialog(h, null, h.planned.find((p) => p.id === id));
      case "place": return startPlacing(h.id);
      case "drag":
        state.dragId = state.dragId === h.id ? null : h.id;
        if (state.dragId) toast(t("map.dragHint"));
        return renderAll();
      case "delete":
        if (confirm(t("confirm.deleteHospital", { name: h.name }))) {
          state.db.hospitals = state.db.hospitals.filter((x) => x.id !== h.id);
          scheduleSave();
          closeFiche();
        }
        return;
    }
  });

  // Met een product: de kleur van dat product. Zonder: die van het ziekenhuis
  // zelf, voor een ziekenhuis waar nog geen product aan hangt.
  function setStatus(h, status, product) {
    const x = (product && h.pipeline[product]) || h;
    if (x.status === status) return;
    x.status = status;
    syncPipeline(h);
    scheduleSave();
    renderAll();
  }

  // ---------- adres zoeken (Photon / OpenStreetMap, geen API-sleutel nodig) ----------
  // Toont suggesties onder het invoerveld; onPick krijgt { address, lat, lng, country }.
  const NUMBER_FIRST = ["GB", "IE", "US", "CA", "AU", "NZ"];
  function addressLabel(p) {
    const nr = [p.housenumber, p.street];
    const street = (NUMBER_FIRST.includes(p.countrycode) ? nr : nr.reverse()).filter(Boolean).join(" ");
    const pc = [p.postcode, p.city || p.district || p.county];
    const place = (NUMBER_FIRST.includes(p.countrycode) ? pc.reverse() : pc).filter(Boolean).join(" ");
    return [...new Set([p.name, street, place, p.state].filter(Boolean))].join(", ");
  }
  function attachAddressSearch(input, onPick) {
    const list = document.createElement("ul");
    list.className = "addr-list";
    list.hidden = true;
    input.after(list);
    let results = [], active = -1, timer = null, seq = 0;

    // De lijst staat vast gepositioneerd, dus bij scrollen sluiten we ze. Die
    // luisteraar hangt aan document en moet er weer af: attachAddressSearch
    // loopt bij élke hertekening van de fiche opnieuw.
    function onScroll(e) { if (!list.contains(e.target)) close(); }
    const close = () => {
      list.hidden = true;
      active = -1;
      document.removeEventListener("scroll", onScroll, true);
    };
    const paint = () => {
      list.innerHTML = results.length
        ? results.map((r, i) => `<li data-i="${i}" class="${i === active ? "active" : ""}">${esc(r.address)}</li>`).join("")
        : `<li class="addr-empty">${esc(t("addr.empty"))}</li>`;
      // Vast gepositioneerd zodat de lijst niet afgesneden wordt door een scrollend dialoogvenster of fiche.
      const r = input.getBoundingClientRect();
      const below = innerHeight - r.bottom - 12;
      list.style.left = r.left + "px";
      list.style.width = r.width + "px";
      list.style.maxHeight = Math.min(260, Math.max(below, r.top - 12)) + "px";
      if (below >= 160 || below >= r.top) { list.style.top = r.bottom + 4 + "px"; list.style.bottom = ""; }
      else { list.style.bottom = innerHeight - r.top + 4 + "px"; list.style.top = ""; }
      list.hidden = false;
      document.addEventListener("scroll", onScroll, true);
    };
    const pick = (i) => {
      const r = results[i];
      if (!r) return;
      input.value = r.address;
      close();
      onPick(r);
    };
    async function search(q) {
      const my = ++seq;
      try {
        // Eerst de Benelux; voorrang aan wat de kaart toont, anders rond Brussel.
        // Niets gevonden? Dan pas wereldwijd zoeken.
        const c = map.getCenter();
        const inRegion = c.lng >= REGION_BBOX[0] && c.lat >= REGION_BBOX[1] && c.lng <= REGION_BBOX[2] && c.lat <= REGION_BBOX[3];
        const [lat, lon] = inRegion ? [c.lat.toFixed(3), c.lng.toFixed(3)] : [50.85, 4.35];
        // Photon kent enkel default, de, en en fr — "nl" geeft een 400. Met
        // "default" komen de namen in de plaatselijke taal, wat voor de Benelux
        // precies is wat we willen (Vlaams-Brabant, Hippokrateslaan, ...).
        const lang = I18N.lang === "nl" ? "default" : "en";
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${lang}&lat=${lat}&lon=${lon}`;
        const ask = async (u) => {
          const res = await fetch(u);
          if (!res.ok) throw new Error(`Photon ${res.status}`);
          return res.json();
        };
        let json = await ask(`${url}&bbox=${REGION_BBOX.join(",")}`);
        if (my !== seq) return;
        if (!json.features.length) json = await ask(url);
        if (my !== seq) return;
        const seen = new Set();
        results = json.features.map((f) => ({
          address: addressLabel(f.properties),
          country: (f.properties.countrycode || "").toUpperCase(),
          lat: +f.geometry.coordinates[1].toFixed(5),
          lng: +f.geometry.coordinates[0].toFixed(5),
        })).filter((r) => !seen.has(r.address) && seen.add(r.address));
        active = -1;
        if (document.activeElement === input) paint();
      } catch (e) {
        // Dienst onbereikbaar of een fout antwoord: toon "niets gevonden" in
        // plaats van de lijst stil te laten verdwijnen, anders lijkt het alsof
        // het zoeken gewoon niets doet.
        if (my !== seq) return;
        results = [];
        if (document.activeElement === input) paint();
        else close();
      }
    }

    input.setAttribute("autocomplete", "off");
    input.placeholder = t("field.address.ph");
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { seq++; return close(); }
      timer = setTimeout(() => search(q), 300);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden || !results.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        paint();
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(active < 0 ? 0 : active);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    // mousedown i.p.v. click: anders verliest het veld eerst de focus en sluit de lijst.
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = e.target.closest("li[data-i]");
      if (li) pick(+li.dataset.i);
    });
  }

  // ---------- dialogen ----------
  // onSubmit krijgt de waarde van de knop waarop geduwd is ("ok", "delete", of
  // bij de export de soort lijst). Geeft onSubmit KEEP_OPEN terug, dan blijft de
  // dialoog open — handig als je er meerdere dingen achter elkaar doet.
  const KEEP_OPEN = "keep-open";
  function openDialog(html, onSubmit) {
    const dlg = $("#dialog");
    const form = $("#dialogForm");
    form.innerHTML = html;
    // #dialogForm wordt door elke dialoog hergebruikt. onchange is een
    // eigenschap en geen luisteraar, zodat die van de vorige dialoog hier
    // vervalt in plaats van zich op te stapelen.
    form.onchange = null;
    dlg.showModal();
    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    form.onsubmit = (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value === "cancel") return;
      // Verwijderen is een eigen recht. De knop staat al verborgen voor wie
      // het niet heeft; dit is het vangnet erachter, net als bij scheduleSave.
      if (submitter.value === "delete") {
        if (!store.can.remove) { toast(t("rights.notAllowed")); return; }
        onSubmit(null, "delete");
        return;
      }
      if (!form.reportValidity()) { e.preventDefault(); return; }
      if (onSubmit(Object.fromEntries(new FormData(form)), submitter.value) === KEEP_OPEN) e.preventDefault();
    };
    return form;
  }

  // Een product komt in h.products zodra een contactpersoon eraan hangt. Valt
  // die weg, dan laten we het product ook vallen — tenzij een andere
  // contactpersoon of een contactmoment het nog gebruikt. Zo blijft het niet
  // eeuwig in de filters staan.
  function syncProducts(h, dropped) {
    const had = h.products.length;
    for (const p of dropped) {
      if (!p || !h.products.includes(p)) continue;
      // Ook wie het product opvolgt, gebruikt het: een fase, een kleur of
      // een verantwoordelijke is werk dat niet mag verdwijnen omdat de laatste
      // contactpersoon wegging.
      const e = h.pipeline[p];
      const followed = !!e && (!!e.owner || e.status !== "red" || e.stage !== "prospect"
        || !!(e.cmm || e.prio || e.doesAlready || e.currentSystem || e.notes));
      const used = followed || h.contacts.some((c) => c.products.includes(p)) || h.activities.some((a) => a.product === p);
      if (!used) h.products = h.products.filter((x) => x !== p);
    }
    // Enkel als hier het laatste product wegviel — een ziekenhuis dat er al
    // geen had, houdt de kleur die iemand het met de hand gaf.
    if (had) zonderProduct(h);
  }

  function contactDialog(h, c) {
    const v = c || { name: "", department: "", role: "", language: "", phone: "", email: "", address: "", products: [], notes: "", primary: false };
    // De vinkjes komen niet via FormData binnen: meerdere vakjes met dezelfde
    // naam houden er maar één over. We lezen ze bij het opslaan uit het
    // formulier zelf.
    const picked = (form) => [...form.querySelectorAll("[data-cproduct]:checked")].map((x) => x.dataset.cproduct);
    const form = openDialog(`
      <h2>${esc(c ? t("dlg.contactEdit") : t("dlg.contactNew"))}</h2>
      <div class="grid">
        <label class="field full">${esc(t("dlg.c.name"))}<input name="name" required value="${esc(v.name)}"></label>
        <label class="field">${esc(t("dlg.c.dept"))}
          <select name="department">${[opt("", "—", v.department), ...DEPARTMENTS.map((d) => opt(d, t("dept." + d), v.department))].join("")}</select>
        </label>
        <label class="field">${esc(t("dlg.c.role"))}<input name="role" value="${esc(v.role)}" placeholder="${esc(t("dlg.c.role.ph"))}"></label>
        <label class="field">${esc(t("dlg.c.phone"))}<input name="phone" value="${esc(v.phone)}"></label>
        <label class="field">${esc(t("dlg.c.email"))}<input name="email" type="email" value="${esc(v.email)}"></label>
        <label class="field full">${esc(t("dlg.c.address"))}<input name="address" value="${esc(v.address)}"></label>
        <div class="field">${esc(t("dlg.c.products"))}
          ${// Niets aangevinkt is hier "geen product", niet "alle" — vandaar
            // het streepje en niet het label van het beheerscherm.
            pickBox(myProducts().map((p) => ({
              attrs: `data-cproduct="${esc(p)}"`, label: p, checked: v.products.includes(p),
            })), "—")}
        </div>
        <label class="field">${esc(t("dlg.c.language"))}
          <select name="language">${[opt("", "—", v.language), ...LANGUAGES.map((l) => opt(l, l, v.language))].join("")}</select>
        </label>
        <label class="field check" style="margin-top:16px"><input type="checkbox" name="primary" ${v.primary ? "checked" : ""}>${esc(t("dlg.c.primary"))}</label>
        <label class="field full">${esc(t("dlg.c.notes"))}<textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      </div>
      <div class="actions">
        ${c ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        if (!confirm(t("confirm.deleteContact", { name: c.name }))) return;
        h.contacts = h.contacts.filter((x) => x.id !== c.id);
        h.activities.forEach((a) => { if (a.contactId === c.id) a.contactId = ""; });
        syncProducts(h, c.products);
      } else {
        const rec = c || { id: uid() };
        const had = c ? [...c.products] : [];
        // Buiten je bereik mag je niets afvinken wat je niet ziet: de vakjes
        // tonen alleen myProducts(), dus houden we de rest van wat er stond.
        const mine = myProducts();
        const keuze = picked(form);
        Object.assign(rec, {
          name: data.name.trim(), department: data.department, role: data.role.trim(), language: data.language,
          phone: data.phone.trim(), email: data.email.trim(), address: data.address.trim(),
          products: [...new Set([...had.filter((p) => !mine.includes(p)), ...keuze])],
          notes: data.notes.trim(), primary: !!data.primary,
        });
        if (rec.primary) h.contacts.forEach((x) => { if (x !== rec) x.primary = false; });
        if (!c) h.contacts.push(rec);
        for (const p of rec.products) if (!h.products.includes(p)) h.products.push(p);
        syncProducts(h, had.filter((p) => !rec.products.includes(p)));
      }
      syncPipeline(h);
      scheduleSave();
      renderAll();
    });
  }

  function activityDialog(h, a, plan) {
    const v = a || (plan ? { ...plan, rooms: "" } : {
      date: today(),
      type: h.activities.length ? "email" : "prospecting",
      product: defaultProduct(h),
      contactId: (h.contacts.find((c) => c.primary) || {}).id || "",
      rooms: "", note: "",
    });
    const form = openDialog(`
      <h2>${esc(a ? t("dlg.actEdit") : t("dlg.actNew"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("dlg.a.date"))}<input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field">${esc(t("dlg.a.type"))}
          <select name="type">${Object.keys(ACT_TYPES).map((k) => opt(k, t("act." + k), v.type)).join("")}</select>
        </label>
        <div class="field">${esc(t("dlg.a.product"))}${productOne(v.product)}</div>
        <label class="field">${esc(t("dlg.a.contact"))}
          <select name="contactId">${[opt("", "—", v.contactId), ...h.contacts.map((c) => opt(c.id, c.name, v.contactId))].join("")}</select>
        </label>
        <label class="field full" id="roomsField"><span id="roomsLabel">${esc(t("dlg.a.rooms"))}</span><input type="number" min="0" name="rooms" value="${esc(v.rooms ?? "")}" placeholder="1"></label>
        <label class="field full">${esc(t("dlg.a.note"))}<textarea name="note" rows="4" placeholder="${esc(t("dlg.a.note.ph"))}">${esc(v.note)}</textarea></label>
      </div>
      ${stampLine(a)}
      <div class="actions">
        ${a ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        if (!confirm(t("confirm.deleteActivity"))) return;
        h.activities = h.activities.filter((x) => x.id !== a.id);
        syncRooms(h, a, null);
      } else {
        // Komt dit uit de agenda, dan erft het contactmoment het id van het
        // plan. De databank ziet dan dat p:<id> verdwijnt en a:<id> opduikt, en
        // weet dat dit afvinken is en geen verwijderen. Niets verwijst naar een
        // id van een gepland moment, dus hergebruiken kan veilig.
        const rec = a || { id: plan ? plan.id : uid() };
        const wantsRooms = wantsQuantity(data.type, data.product);
        // Toestand vóór de wijziging, om straks het verschil te kunnen toepassen.
        const before = a ? { type: rec.type, rooms: rec.rooms, product: rec.product } : null;
        Object.assign(rec, {
          date: data.date, type: data.type, product: data.product, contactId: data.contactId,
          rooms: wantsRooms ? num(data.rooms) : null, note: data.note.trim(),
        });
        stamp(rec, !a);
        if (!a) h.activities.push(rec);
        // Een contactmoment voor een product zet dat product bij het
        // ziekenhuis: anders is er geen opvolging om bij te werken.
        if (rec.product && !h.products.includes(rec.product)) h.products.push(rec.product);
        syncPipeline(h);
        // Ook bij een wijziging: een contactmoment dat nú een installatie of
        // een bestelling is, zet de kleur en de fase mee goed.
        if (!a || before.type !== rec.type) autoStatus(h, rec);
        // Een installatie of demo met aantal kamers werkt de afdelingsgegevens bij.
        syncRooms(h, before, rec);
        // Kwam dit uit de agenda, dan is het nu gebeurd en hoeft het niet meer
        // gepland te staan.
        if (plan) {
          h.planned = h.planned.filter((x) => x.id !== plan.id);
          syncNextAction(h);
          toast(t("toast.planDone"));
        }
      }
      scheduleSave();
      renderAll();
    });
    // Het aantal hangt af van soort én product: kamers bij een abonnement,
    // bestelde stuks bij een product per ingreep. Het veld is hetzelfde, het
    // opschrift volgt het product.
    const sync = () => {
      const product = form.elements.product.value;
      $("#roomsField", form).hidden = !wantsQuantity(form.elements.type.value, product);
      $("#roomsLabel", form).textContent = t(productKind(product) === "procedure" ? "dlg.a.quantity" : "dlg.a.rooms");
    };
    form.onchange = sync;
    sync();
  }

  // Een moment plannen. Dezelfde soorten als een contactmoment, zodat een kleur
  // in de agenda hetzelfde betekent, maar zonder kamers en zonder invloed op
  // status, fase of statistieken.
  function plannedDialog(h, p) {
    const v = p || {
      date: today(),
      type: "visit",
      product: defaultProduct(h),
      contactId: (h.contacts.find((c) => c.primary) || {}).id || "",
      note: "",
    };
    openDialog(`
      <h2>${esc(p ? t("dlg.plannedEdit") : t("dlg.plannedNew"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("dlg.p.date"))}<input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field">${esc(t("dlg.p.type"))}
          <select name="type">${ACT_TYPE_KEYS.map((k) => opt(k, t("act." + k), v.type)).join("")}</select>
        </label>
        <div class="field">${esc(t("dlg.p.product"))}${productOne(v.product)}</div>
        <label class="field">${esc(t("dlg.p.contact"))}
          <select name="contactId">${[opt("", "—", v.contactId), ...h.contacts.map((c) => opt(c.id, c.name, v.contactId))].join("")}</select>
        </label>
        <label class="field full">${esc(t("dlg.p.note"))}<textarea name="note" rows="3" placeholder="${esc(t("dlg.p.note.ph"))}">${esc(v.note)}</textarea></label>
      </div>
      ${stampLine(p)}
      <div class="actions">
        ${p ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        if (!confirm(t("confirm.deletePlanned"))) return;
        h.planned = h.planned.filter((x) => x.id !== p.id);
      } else {
        const rec = p || { id: uid() };
        Object.assign(rec, {
          date: data.date, type: data.type, product: data.product,
          contactId: data.contactId, note: data.note.trim(),
        });
        stamp(rec, !p);
        if (!p) h.planned.push(rec);
        h.planned.sort((a, b) => a.date.localeCompare(b.date));
      }
      syncNextAction(h);
      scheduleSave();
      renderAll();
    });
  }

  // Verkoopfase bepaalt mee de kleur: Klant = groen, actieve fases = oranje.
  // x is waar de fase en de kleur staan: de opvolging van één product, of het
  // ziekenhuis zelf zolang er geen product aan hangt.
  function stageStatus(x, contacted) {
    const before = x.status;
    if (x.stage === "customer") x.status = "green";
    else if (x.stage === "prospect") x.status = contacted ? x.status : "red";
    else if (x.stage !== "not_interested" && x.status !== "green") x.status = "orange";
    if (x.status !== before) toast(x.status === "green" ? t("status.toGreen") : t("status.toOrange"));
  }

  // Kleur automatisch mee laten evolueren; manueel aanpassen blijft altijd mogelijk.
  // Een contactmoment hoort bij één product, dus het is de opvolging van dát
  // product die meebeweegt — een bestelling voor het ene maakt het andere niet
  // groen.
  function autoStatus(h, act) {
    // Zonder product op het contactmoment: hangt er precies één product aan
    // het ziekenhuis, dan is het dat. Hangen er meer aan, dan valt niet te
    // raden welk — en dan blijft alles staan, liever dan het verkeerde product
    // groen te maken. Hangt er geen aan, dan is het het ziekenhuis zelf.
    const rows = myProducts().filter((p) => h.products.includes(p) && h.pipeline[p]);
    const x = (act.product && h.pipeline[act.product])
      || (rows.length === 1 ? h.pipeline[rows[0]] : rows.length ? null : h);
    if (!x) return;
    if ((act.type === "installation" || act.type === "order") && x.status !== "green") {
      x.status = "green";
      if (PRE_SALE.includes(x.stage)) x.stage = "customer";
      toast(t("status.toGreen"));
    } else if (x.status === "red") {
      x.status = "orange";
      if (x.stage === "prospect") x.stage = "first_contact";
      toast(t("status.toOrange"));
    }
    // Na een demo: geïnstalleerd bij een product per abonnement, in evaluatie
    // bij een product per ingreep, waar niets geïnstalleerd wordt.
    if (act.type === "demo" && ["prospect", "first_contact", "meeting", "demo_planned"].includes(x.stage)) {
      x.stage = productKind(act.product) === "procedure" ? "evaluation" : "demo_installed";
    }
    syncPipeline(h);
  }

  // Kamers van de afdeling bijwerken na een demo, installatie of stopzetting.
  //
  // Installaties tellen op: na een installatie van 2 en later nog een van 3
  // staan er 5 kamers live. Een stopgezet abonnement telt er weer af. We passen
  // het verschil toe en niet de som van alle contactmomenten, zodat een aantal
  // dat hier al handmatig stond blijft staan.
  // Een demo overschrijft wél: dat is de huidige toestand, geen optelsom — we
  // nemen het aantal van de laatste demo waarvoor een aantal is ingevuld.
  function syncRooms(h, before, after) {
    // Alleen voor een product per abonnement: het aantal bij een RFA-bestelling
    // zijn stuks, geen kamers, en hoort dus niet bij de afdeling opgeteld.
    const perKamer = (a) => !!a && productKind(a.product) === "subscription";
    const installed = (a) => {
      if (!perKamer(a) || !a.rooms) return 0;
      if (a.type === "installation") return a.rooms;
      if (a.type === "cancellation") return -a.rooms;
      return 0;
    };
    const delta = installed(after) - installed(before);
    if (delta > 0 || (delta < 0 && h.unit.roomsInstalled != null)) {
      h.unit.roomsInstalled = Math.max(0, (h.unit.roomsInstalled || 0) + delta);
    }
    if ((perKamer(before) && before.type === "demo") || (perKamer(after) && after.type === "demo")) {
      const demos = h.activities.filter((a) => a.type === "demo" && a.rooms && perKamer(a));
      if (demos.length) h.unit.roomsDemo = demos.sort((a, b) => b.date.localeCompare(a.date))[0].rooms;
    }
  }

  // ---------- nieuw ziekenhuis ----------
  $("#addHospitalBtn").addEventListener("click", () => {
    openDialog(`
      <h2>${esc(t("dlg.newHospital"))}</h2>
      <div class="grid">
        <label class="field full">${esc(t("dlg.c.name"))}<input name="name" required></label>
        <label class="field">${esc(t("field.country"))}
          <select name="country">${[opt("", "—", ""), ...COUNTRIES.map((c) => opt(c, t("country." + c), ""))].join("")}</select>
        </label>
        <label class="field">${esc(t("field.sector"))}
          <select name="sector">${[opt("", "—", ""), ...SECTORS.map((s) => opt(s, t("sector." + s), ""))].join("")}</select>
        </label>
        <label class="field full">${esc(t("field.address"))}<input name="address"></label>
        <input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="cc">
      </div>
      <p class="muted" id="addrHint">${esc(t("dlg.addrHint"))}</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.create"))}</button>
      </div>`, (data) => {
      const hasLoc = data.lat !== "" && data.lng !== "";
      const h = normalize({
        id: uid(), name: data.name.trim(), country: data.country || (COUNTRIES.includes(data.cc) ? data.cc : ""),
        sector: data.sector, address: data.address.trim(),
        lat: hasLoc ? +data.lat : null, lng: hasLoc ? +data.lng : null,
        status: "red", stage: "prospect", products: [], nextAction: "", nextActionDate: "",
        notes: "", createdAt: today(),
      });
      state.db.hospitals.push(h);
      scheduleSave();
      if (hasLoc) {
        select(h.id, true);
        toast(t("toast.created"));
      } else {
        select(h.id, false);
        startPlacing(h.id);
      }
    });
    const form = $("#dialogForm");
    const addr = form.querySelector('[name="address"]');
    attachAddressSearch(addr, (r) => {
      form.lat.value = r.lat;
      form.lng.value = r.lng;
      form.cc.value = r.country || "";
      if (!form.country.value && COUNTRIES.includes(r.country)) form.country.value = r.country;
      $("#addrHint").textContent = t("dlg.addrFound");
    });
    // Adres na het kiezen nog aangepast? Dan geldt de gekozen locatie niet meer.
    addr.addEventListener("input", () => {
      if (!form.lat.value) return;
      form.lat.value = form.lng.value = form.cc.value = "";
      $("#addrHint").textContent = t("dlg.addrHint");
    });
  });

  // ---------- export / import ----------
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Puntkomma + decimale komma, zoals Excel met Belgische/Nederlandse instellingen verwacht.
  // Een cel die met = + - @ een tab of een regeleinde begint, wordt door Excel
  // als formule uitgevoerd; een voorafgaande ' maakt er weer gewone tekst van.
  const csvCell = (v) => {
    if (typeof v === "number") return String(v).replace(".", ",");
    const s = String(v ?? "");
    return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
  };
  const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");

  // Het logo brengt je terug naar de kaart, vanuit elk paneel.
  $("#homeBtn").addEventListener("click", () => { closeFiche(); setView("map"); });

  $("#exportBtn").addEventListener("click", () => {
    openDialog(`
      <h2>${esc(t("dlg.export"))}</h2>
      <p class="muted">${esc(t("dlg.exportHint"))}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">${esc(t("export.hospitals"))}</button>
        <button class="btn" value="contacts">${esc(t("export.contacts"))}</button>
        <button class="btn" value="activities">${esc(t("export.activities"))}</button>
        ${endoAccount() ? `<button class="btn" value="units">${esc(t("export.units"))}</button>` : ""}
        <button class="btn" value="json">${esc(t("export.json"))}</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">${esc(t("btn.close"))}</button></div>`, (data, kind) => {
      const hs = state.db.hospitals;
      const d = today();
      // De kolom "Demo gepland op" bestaat nog; de datum komt uit het eerste
      // geplande demomoment dat nog moet komen.
      const demoDate = (h) => ((h.planned.find((p) => p.type === "demo" && p.date >= d) || {}).date) || "";
      if (kind === "hospitals") {
        download(`hospitals-${d}.csv`, csv([
          [t("col.name"), t("col.country"), t("col.sector"), t("col.status"), t("col.stage"), t("col.products"),
            t("col.lastContact"), t("col.demos"), ...(endoAccount() ? [t("col.installations"), t("unit.roomsInstalled")] : []),
            t("col.demoDate"), t("col.nextAction"), t("col.nextActionDate"), t("col.primaryContact"),
            t("col.address"), t("col.createdAt"), t("col.notes"),
            t("field.network"), t("field.sites"),
            ...myProducts().flatMap((p) => [`${t("col.stage")} ${p}`, `${t("col.owner")} ${p}`,
              ...(productKind(p) === "procedure" ? ["rfa.cmm", "rfa.prio", "rfa.doesAlready", "rfa.currentSystem", "rfa.notes"].map((k) => `${t(k)} ${p}`) : [])])],
          ...hs.map((h) => [h.name, h.country && t("country." + h.country), h.sector && t("sector." + h.sector),
            t("status." + h.status), t("stage." + h.stage), h.products.join(", "), lastContact(h),
            countType(h, "demo"), ...(endoAccount() ? [countType(h, "installation"), h.unit.roomsInstalled ?? ""] : []),
            demoDate(h), h.nextAction, h.nextActionDate, (h.contacts.find((c) => c.primary) || {}).name,
            h.address, h.createdAt, h.notes,
            h.network, h.sites,
            ...myProducts().flatMap((p) => {
              const e = h.products.includes(p) && h.pipeline[p];
              const rfa = productKind(p) === "procedure";
              if (!e) return rfa ? ["", "", "", "", "", "", ""] : ["", ""];
              return [t("stage." + e.stage), personName(e.owner),
                ...(rfa ? [e.cmm && t("rfa.cmm." + e.cmm), e.prio ?? "", e.doesAlready && t("yn." + e.doesAlready), e.currentSystem, e.notes] : [])];
            })]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`contacts-${d}.csv`, csv([
          [t("col.hospital"), t("col.name"), t("col.dept"), t("col.role"), t("col.phone"), t("col.email"), t("col.language"), t("col.address"), t("col.product"), t("col.isPrimary"), t("col.notes")],
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.department && t("dept." + c.department), c.role,
            c.phone, c.email, c.language, c.address, c.products.join(" / "), c.primary ? t("col.yes") : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`activities-${d}.csv`, activitiesCsv(hs.flatMap((h) => h.activities.map((a) => ({ h, a })))), "text/csv");
      } else if (kind === "units") {
        download(`units-${d}.csv`, csv([
          [t("col.name"), t("col.country"), t("unit.scopeBrands"), t("unit.scopeNotes"),
            t("unit.processorBrands"), t("unit.processorNotes"), t("unit.rooms"),
            t("unit.roomsDemo"), t("unit.roomsInstalled"), t("unit.colosPerYear"), t("unit.existingAI"), t("unit.screening")],
          ...hs.map((h) => [h.name, h.country && t("country." + h.country),
            h.unit.scopeBrands.map(scopeLabel).join(", "), h.unit.scopeNotes,
            h.unit.processorBrands.map(scopeLabel).join(", "), h.unit.processorNotes,
            h.unit.rooms ?? "", h.unit.roomsDemo ?? "", h.unit.roomsInstalled ?? "", h.unit.colosPerYear ?? "",
            h.unit.existingAI, h.unit.screening ? t("col.yes") : ""]),
        ]), "text/csv");
      } else if (kind === "json") {
        download(`followup-prion-backup-${d}.json`, JSON.stringify(state.db, null, 2), "application/json");
      }
      return KEEP_OPEN; // meestal wil je meer dan één lijst
    });
  });

  $("#importBtn").addEventListener("click", () => {
    if (!store.can.importData) return toast(t("rights.notAllowed"));
    $("#importFile").click();
  });
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.hospitals)) throw new Error(t("import.noHospitals"));
      if (!confirm(t("import.confirm", { n: data.hospitals.length }))) return;
      data.hospitals.forEach(normalize);
      state.db = data;
      state.selectedId = null;
      saveMode = "import";
      scheduleSave();
      renderAll();
      fitAll();
      toast(t("import.done"));
    } catch (err) {
      alert(t("import.failed", { msg: err.message }));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#dialog").open) {
      if (state.placing) $("#cancelPlace").click();
      else if (!menuList.hidden) toggleMenu(false);
      else if (state.selectedId) closeFiche();
    }
    if (e.key === "/" && document.activeElement === document.body) { e.preventDefault(); $("#search").focus(); }
  });

  // ---------- agenda ----------
  // Alle geplande momenten van alle ziekenhuizen samen: een maandrooster om te
  // zien waar het druk is, en eronder de lijst om mee te werken. De maand- en
  // weekdagnamen komen van Intl en niet uit i18n.js — dat zijn negentien
  // sleutels minder om in twee talen bij te houden.
  function plannedAll() {
    const out = [];
    for (const h of state.db.hospitals) for (const p of h.planned) out.push({ h, p });
    return out.sort((a, b) => a.p.date.localeCompare(b.p.date) || a.h.name.localeCompare(b.h.name));
  }

  function agendaRow({ h, p }) {
    const sub = momentLine(h, p, true);
    const when = new Date(p.date + "T00:00:00").toLocaleDateString(I18N.locale, { weekday: "short", day: "numeric", month: "short" });
    return `<li class="ag-row ${p.date < today() ? "late" : ""}" data-hid="${esc(h.id)}" data-pid="${esc(p.id)}">
      <div class="ag-date"><b>${esc(when)}</b><span>${esc(relDays(p.date))}</span></div>
      <div class="ag-body">
        <div class="ag-name">${esc(h.name)}</div>
        <div class="ag-sub"><span class="type-pill" style="background:${ACT_TYPES[p.type] || "#999"}"></span>${esc(sub)}</div>
        ${p.note ? `<div class="ag-note">${esc(p.note)}</div>` : ""}
      </div>
      <div class="ag-acts">
        <button class="icon-btn" data-ag="done" title="${esc(t("btn.done.title"))}" aria-label="${esc(t("btn.done.title"))}">${icon("check")}</button>
        <button class="icon-btn" data-ag="edit" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
        <button class="icon-btn" data-ag="open" title="${esc(t("agenda.open"))}" aria-label="${esc(t("agenda.open"))}">${icon("arrow")}</button>
      </div>
    </li>`;
  }

  function renderAgenda() {
    if (state.agenda.tab === "log") return renderLog();
    const { y, m, day } = state.agenda;
    const items = plannedAll();
    const td = today();
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const overdue = items.filter((x) => x.p.date < td);
    const inMonth = items.filter((x) => x.p.date.startsWith(month));
    const byDay = new Map();
    for (const x of inMonth) {
      if (!byDay.has(x.p.date)) byDay.set(x.p.date, []);
      byDay.get(x.p.date).push(x);
    }
    // 1 januari 2024 was een maandag; enkel om de weekdagnamen op te halen.
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      new Date(2024, 0, 1 + i).toLocaleDateString(I18N.locale, { weekday: "short" }));
    const monthLabel = new Date(y, m, 1).toLocaleDateString(I18N.locale, { month: "long", year: "numeric" });
    // Maandag vooraan, en de laatste dag van de maand via dag 0 van de volgende.
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<span class="cal-day empty"></span>`);
    for (let d = 1; d <= days; d++) {
      const date = ymd(y, m, d);
      const list = byDay.get(date) || [];
      const dots = list.slice(0, 4).map((x) => `<i style="background:${ACT_TYPES[x.p.type] || "#999"}"></i>`).join("");
      const cls = ["cal-day", date === td ? "today" : "", date === day ? "sel" : "", list.length && date < td ? "late" : ""].filter(Boolean).join(" ");
      // Een schermlezer hoort anders enkel de datum: het aantal erbij.
      const label = list.length ? `${fmtDate(date)} · ${t("agenda.planned", { n: list.length })}` : fmtDate(date);
      cells.push(`<button class="${cls}" data-day="${date}" aria-label="${esc(label)}" aria-pressed="${date === day}">
        <span class="cal-n">${d}</span>
        <span class="cal-dots">${dots}${list.length > 4 ? `<em>+${list.length - 4}</em>` : ""}</span>
      </button>`);
    }
    // Een maand die voorbij is tonen we volledig: daar staat niets meer "nog
    // te doen", en een lege lijst naast gevulde bolletjes in het rooster leest
    // als een fout. "Te laat" laten we er dan weg, anders staat alles dubbel.
    const past = month < td.slice(0, 7);
    const shown = day ? items.filter((x) => x.p.date === day)
      : past ? inMonth : inMonth.filter((x) => x.p.date >= td);
    agendaView.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("agenda.title"))}</h2>
        <div class="ag-nav">
          <button class="btn small" data-ag="prev" title="${esc(t("btn.prevMonth"))}" aria-label="${esc(t("btn.prevMonth"))}">${icon("prev")}</button>
          <button class="btn small" data-ag="today">${esc(t("btn.today"))}</button>
          <button class="btn small" data-ag="next" title="${esc(t("btn.nextMonth"))}" aria-label="${esc(t("btn.nextMonth"))}">${icon("next")}</button>
        </div>
        ${// De schakelaar als laatste, op beide tabbladen: zo staat hij op
          // dezelfde plaats en verspringt hij niet onder je muis.
          agendaTabs()}
      </div>
      <div class="cal">
        <div class="cal-month">${esc(monthLabel)}</div>
        <div class="cal-grid">
          ${weekdays.map((w) => `<span class="cal-wd">${esc(w)}</span>`).join("")}
          ${cells.join("")}
        </div>
      </div>
      ${items.length ? "" : `<p class="muted">${esc(t("agenda.none"))}</p>`}
      ${overdue.length && !day && !past ? `<div class="ag-block">
        <h3 class="ag-h">${esc(t("agenda.overdue"))} <span class="badge">${overdue.length}</span></h3>
        <ul class="ag-list">${overdue.map(agendaRow).join("")}</ul>
      </div>` : ""}
      ${items.length ? `<div class="ag-block">
        <h3 class="ag-h">${esc(day ? fmtDate(day) : monthLabel)}${day ? ` · <button class="link" data-ag="clear">${esc(t("btn.wholeMonth"))}</button>` : ""}</h3>
        ${shown.length ? `<ul class="ag-list">${shown.map(agendaRow).join("")}</ul>`
          : `<p class="muted">${esc(t(day ? "agenda.dayEmpty" : past ? "agenda.monthNone" : "agenda.monthEmpty"))}</p>`}
      </div>` : ""}`;
  }

  // ---------- logboek ----------
  // De andere helft van de agenda: niet wat komt maar wat gebeurd is, over
  // alle ziekenhuizen heen. In de fiche zie je de contactmomenten van één
  // ziekenhuis; hier de vraag "wat is er deze week gebeurd".
  //
  // Afschermen hoeft hier niet apart: de databank stuurt een account alleen de
  // contactmomenten van zijn eigen producten, dus dit is vanzelf beperkt.
  const LOG_STEP = 50;
  const LOG_PERIODS = ["week", "month", "quarter", "year", "all"];
  const agendaTabs = () => `<div class="s-seg">${[["planned", "agenda.tabPlanned"], ["log", "agenda.tabLog"]].map(([k, key]) =>
    `<button data-ag-tab="${k}" class="${state.agenda.tab === k ? "active" : ""}"><span>${esc(t(key))}</span></button>`).join("")}</div>`;
  // De eerste dag van de periode, of leeg voor alles.
  function periodStart(period) {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth();
    if (period === "week") { const s = new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7)); return ymd(s.getFullYear(), s.getMonth(), s.getDate()); }
    if (period === "month") return ymd(y, m, 1);
    if (period === "quarter") { const s = new Date(y, m - 3, d.getDate()); return ymd(s.getFullYear(), s.getMonth(), s.getDate()); }
    if (period === "year") return ymd(y, 0, 1);
    return "";
  }
  // De week van een datum: de maandag als sleutel, en het ISO-weeknummer, dat
  // bij de donderdag van die week hoort.
  function weekOf(date) {
    const d = new Date(date + "T00:00:00");
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const thu = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3);
    const n = Math.floor(Math.round((thu - new Date(thu.getFullYear(), 0, 1)) / 86400000) / 7) + 1;
    const short = (x) => x.toLocaleDateString(I18N.locale, { day: "numeric", month: "short" });
    // Het jaar erbij zodra het niet het lopende is: over "alles" staat week 45
    // er anders twee keer, zonder dat je ziet van wanneer.
    const year = thu.getFullYear() === new Date().getFullYear() ? "" : ` ${thu.getFullYear()}`;
    return { key: ymd(mon.getFullYear(), mon.getMonth(), mon.getDate()), label: `${t("log.week", { n })} · ${short(mon)} – ${short(sun)}${year}` };
  }
  // Alles wat bij de keuze past, recentste eerst.
  //
  // De filters van de kaart gelden voor het ziekenhuis (land,
  // verantwoordelijke) en voor het contactmoment zelf (product). Kom je uit
  // een fiche, dan gelden ze niet: je vroeg om de contactmomenten van dát
  // ziekenhuis, en de fiche toonde ze ook allemaal. Periode, soort en
  // "ingevoerd door" blijven wel gelden — die staan er nog en zijn van hier.
  //
  // Zoeken gaat per contactmoment en niet per ziekenhuis: elk woord moet
  // voorkomen in het ziekenhuis, de contactpersoon van dít moment, de soort,
  // het product of de nota. Wie op een arts zoekt krijgt dus de momenten met
  // die arts, niet alles van zijn ziekenhuis.
  function logItems() {
    const L = state.log;
    const from = periodStart(L.period);
    const only = L.hospitalId && byId(L.hospitalId);
    const words = only ? [] : state.filter.query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const h of only ? [only] : scopedHospitals()) {
      const place = [h.name, h.address, h.network, h.sites].join(" ");
      for (const a of h.activities) {
        if (!only && !inFilter(a)) continue;
        if (from && a.date < from) continue;
        if (L.types.length && !L.types.includes(a.type)) continue;
        if (L.authors.length && !L.authors.includes(a.createdBy)) continue;
        if (words.length) {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const hay = [place, c && c.name, t("act." + a.type), a.product, a.note].join(" ").toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
        }
        out.push({ h, a });
      }
    }
    return out.sort((x, y) => y.a.date.localeCompare(x.a.date) || x.h.name.localeCompare(y.h.name));
  }
  // Uit een fiche gekomen: het logboek van dat ene ziekenhuis, over de hele
  // periode. Dat is een uitstap, geen instelling — de periode van daarvoor
  // wordt onthouden en komt terug zodra je het ziekenhuis loslaat of de
  // agenda verlaat.
  function openLogFor(h) {
    if (!state.log.hospitalId) state.log.prevPeriod = state.log.period;
    state.log = { ...state.log, hospitalId: h.id, period: "all", limit: LOG_STEP };
    state.agenda = { ...state.agenda, tab: "log" };
    setView("agenda");
  }
  function clearLogHospital() {
    if (!state.log.hospitalId) return;
    state.log = { ...state.log, hospitalId: "", period: state.log.prevPeriod || "quarter", limit: LOG_STEP };
  }
  function logRow({ h, a }) {
    const sub = momentLine(h, a, true);
    const when = new Date(a.date + "T00:00:00").toLocaleDateString(I18N.locale, { weekday: "short", day: "numeric", month: "short" });
    return `<li class="ag-row" data-hid="${esc(h.id)}" data-aid="${esc(a.id)}">
      <div class="ag-date"><b>${esc(when)}</b><span>${esc(relDays(a.date))}</span></div>
      <div class="ag-body">
        <div class="ag-name">${esc(h.name)}</div>
        <div class="ag-sub"><span class="type-pill" style="background:${ACT_TYPES[a.type] || "#999"}"></span>${esc(sub)}</div>
        ${a.note ? `<div class="ag-note">${esc(a.note)}</div>` : ""}
      </div>
      <div class="ag-acts">
        <button class="icon-btn" data-ag="edit" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
        <button class="icon-btn" data-ag="open" title="${esc(t("agenda.open"))}" aria-label="${esc(t("agenda.open"))}">${icon("arrow")}</button>
      </div>
    </li>`;
  }
  // Alleen de lijst, niet de filters erboven: anders klapt de uitklapper dicht
  // bij elk vinkje, en verliest het zoekveld zijn cursor bij elke letter.
  function renderLogBody() {
    const body = $("#logBody", agendaView);
    if (!body) return;
    const items = logItems();
    if (!items.length) { body.innerHTML = `<p class="muted">${esc(t("log.empty"))}</p>`; return; }
    const counts = {};
    for (const { a } of items) counts[a.type] = (counts[a.type] || 0) + 1;
    const perType = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${t("act." + k).toLowerCase()}`).join(" · ");
    const visible = items.slice(0, state.log.limit);
    const weeks = [];
    for (const x of visible) {
      const w = weekOf(x.a.date);
      if (!weeks.length || weeks[weeks.length - 1].key !== w.key) weeks.push({ ...w, rows: [] });
      weeks[weeks.length - 1].rows.push(x);
    }
    body.innerHTML = `
      <p class="log-sum"><b>${esc(items.length === 1 ? t("log.countOne") : t("log.count", { n: items.length }))}</b>${perType ? ` — ${esc(perType)}` : ""}
        <button class="btn small" data-log-export>${esc(t("log.export"))}</button></p>
      ${weeks.map((w) => `<div class="ag-block">
        <h3 class="ag-h">${esc(w.label)}</h3>
        <ul class="ag-list">${w.rows.map(logRow).join("")}</ul>
      </div>`).join("")}
      ${items.length > visible.length ? `<p class="log-more"><span class="muted">${esc(t("log.shown", { n: visible.length, total: items.length }))}</span>
        <button class="btn small" data-log-more>${esc(t("log.more"))}</button></p>` : ""}`;
  }
  function renderLog() {
    const L = state.log;
    const only = L.hospitalId && byId(L.hospitalId);
    if (L.hospitalId && !only) clearLogHospital();
    const pick = (key, items, label, leeg) => pickBox(items.map((k) => ({
      attrs: `data-log-pick="${esc(key)}" data-value="${esc(k)}"`, label: label(k), checked: L[key].includes(k),
    })), leeg);
    agendaView.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("agenda.title"))}</h2>
        ${agendaTabs()}
      </div>
      <div class="s-filters log-filters">
        <label>${esc(t("log.period"))} <select data-log-period>${LOG_PERIODS.map((p) => opt(p, t("log.period." + p), L.period)).join("")}</select></label>
        ${only ? "" : FILTERS.filter((f) => f.key !== "statuses" && f.items().length).map((f) => `<label>${pickBox(f.items().map((k) => ({
          attrs: `data-filter="${esc(f.key)}" data-value="${esc(k)}"`, label: f.label(k), checked: state.filter[f.key].includes(k),
        })), t(f.leeg))}</label>`).join("")}
        <label>${pick("types", ACT_TYPE_KEYS, (k) => t("act." + k), t("log.allTypes"))}</label>
        ${owners().length ? `<label>${esc(t("log.author"))} ${pick("authors", owners().map(([id]) => id), personName, t("log.allAuthors"))}</label>` : ""}
        ${only ? "" : `<input type="search" data-log-search value="${esc(state.filter.query)}" placeholder="${esc(t("log.search"))}" aria-label="${esc(t("log.search"))}">`}
      </div>
      ${only ? `<p class="log-only">${esc(t("log.hospital"))}: <b>${esc(only.name)}</b> <button class="link" data-log-clear>${esc(t("log.allHospitals"))}</button></p>` : ""}
      <div id="logBody"></div>`;
    renderLogBody();
  }
  // Enkel wat hier geselecteerd staat — álles daarvan, niet alleen wat al
  // geladen is.
  function exportLog() {
    download(`logboek-${today()}.csv`, activitiesCsv(logItems()), "text/csv");
  }

  // ---------- start ----------
  function renderAll() {
    if (!statsView.hidden) window.FollowUpStats.render(state.db, statsView, scheduleSave);
    if (!agendaView.hidden) renderAgenda();
    if (!usersView.hidden) renderUsers();
    renderKpis();
    renderList();
    renderMarkers();
    renderFiche();
    setTimeout(() => map.invalidateSize(), 0);
  }

  async function init() {
    document.documentElement.lang = I18N.lang;
    I18N.applyStatic();
    updateLangBtn();
    // Eerst het krapste recht, dan pas wat deze gebruiker echt mag. Zo staat er
    // geen knop klaar zolang we niet weten wie er aanmeldt, en blijft het bij
    // "niets mogen" als het aanmelden mislukt.
    applyRights();
    try {
      await store.ready();
      applyRights();
      await loadPeople();
      // Nu pas zijn de namen er: de filter op verantwoordelijke heeft ze nodig.
      renderFilters();
      const { db, empty } = await store.load();
      state.db = db;
      // Het versienummer zegt of deze app de vorm van de data nog begrijpt.
      // Komt ze van een nieuwere versie, dan waarschuwen we en laten we het
      // nummer staan — overschrijven zou stille gegevensverlies betekenen.
      if (Number(state.db.version) > DB_VERSION) showBanner(t("save.newerVersion"));
      state.db.version = Math.max(Number(state.db.version) || 1, DB_VERSION);
      state.db.hospitals.forEach(normalize);
      // read_state geeft de rol en het bereik mee waarmee dit document is
      // uitgelezen; is daar iets aan veranderd, dan kloppen de knoppen nu pas.
      applyRights();
      showSaveState("save.saved");
      if (empty) offerSeed();
    } catch (e) {
      showBanner(e.message);
    }
    if (store.mode === "supabase") $("#logoutBtn").hidden = false;
    renderAll();
    map.invalidateSize();
    fitAll();
  }

  // Lege online databank: startlijst laden of een back-up importeren.
  function offerSeed() {
    const b = $("#banner");
    b.textContent = t("seed.empty");
    // Zonder schrijfrecht blijft het bij de melding: de knop zou toch stuiten
    // op de grendel in scheduleSave en op de databank. Met een productbeperking
    // net zo: write_state() laat een leeg project enkel vullen door een
    // onbeperkte bewerker, want wie maar een deel ziet, zet maar een deel neer.
    if (!store.can.write || store.can.products.length) { b.hidden = false; return; }
    const btn = document.createElement("button");
    btn.className = "btn small primary";
    btn.textContent = t("seed.load");
    btn.onclick = async () => {
      try {
        const res = await fetch("../data/seed.json", { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        state.db = await res.json();
        state.db.hospitals.forEach(normalize);
        showBanner("");
        scheduleSave();
        renderAll();
        fitAll();
        toast(t("seed.loaded", { n: state.db.hospitals.length }));
      } catch (e) {
        alert(t("seed.missing"));
      }
    };
    b.append(btn, t("seed.or"));
    b.hidden = false;
  }

  $("#logoutBtn").addEventListener("click", () => store.signOut());

  // ---------- taal ----------
  function updateLangBtn() {
    const b = $("#langBtn");
    b.textContent = t("lang.switch");
    b.title = t("lang.title");
  }
  $("#langBtn").addEventListener("click", () => I18N.setLang(I18N.other));
  I18N.onChange(() => {
    updateLangBtn();
    showSaveState(saveState.key, saveState.error);
    $("#statsBtn").textContent = statsView.hidden ? t("btn.stats") : t("btn.backToMap");
    $("#agendaBtn").textContent = agendaView.hidden ? t("btn.agenda") : t("btn.backToMap");
    // De filters dragen vertaalde labels en worden in JavaScript opgebouwd,
    // dus data-i18n raakt er niet bij.
    renderFilters();
    renderAll();
  });

  // ---------- schermen: lijst / kaart / agenda / statistieken ----------
  // Op desktop staan lijst en kaart naast elkaar; op gsm kies je via de tabbalk.
  const statsView = $("#statsView");
  const agendaView = $("#agendaView");
  const usersView = $("#usersView");
  function setView(view) {
    if (view !== "agenda") clearLogHospital();
    document.body.dataset.view = view;
    statsView.hidden = view !== "stats";
    agendaView.hidden = view !== "agenda";
    usersView.hidden = view !== "users";
    $("#statsBtn").textContent = view === "stats" ? t("btn.backToMap") : t("btn.stats");
    $("#agendaBtn").textContent = view === "agenda" ? t("btn.backToMap") : t("btn.agenda");
    document.querySelectorAll(".tabbar [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    try { localStorage.setItem("followup-view", view); } catch (e) { /* privévenster */ }
    if (view === "stats") window.FollowUpStats.render(state.db, statsView, scheduleSave);
    else window.FollowUpStats.hideTip();
    if (view === "agenda") renderAgenda();
    if (view === "users") loadUsers();
    if (view === "map") setTimeout(() => {
      map.invalidateSize();
      if (state.pendingFocus) {
        map.setView(state.pendingFocus, Math.max(map.getZoom(), 13), { animate: false });
        state.pendingFocus = null;
        state.pendingFit = false;
      } else if (state.pendingFit) {
        state.pendingFit = false;
        fitAll();
      }
    }, 0);
  }
  $("#statsBtn").addEventListener("click", () => setView(statsView.hidden ? "stats" : "map"));
  $("#agendaBtn").addEventListener("click", () => setView(agendaView.hidden ? "agenda" : "map"));

  // Knoppen in de agenda: maand vooruit of achteruit, een dag kiezen, en per
  // regel afvinken, aanpassen of naar de fiche gaan.
  agendaView.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-ag-tab]");
    if (tab) {
      state.agenda = { ...state.agenda, tab: tab.dataset.agTab };
      return renderAgenda();
    }
    if (e.target.closest("[data-log-more]")) { state.log.limit += LOG_STEP; return renderLogBody(); }
    if (e.target.closest("[data-log-clear]")) { clearLogHospital(); return renderAgenda(); }
    if (e.target.closest("[data-log-export]")) return exportLog();
    const b = e.target.closest("[data-ag]");
    if (b) {
      const row = b.closest(".ag-row");
      // Een regel uit het logboek: een contactmoment, geen gepland moment.
      if (row && row.dataset.aid) {
        const h = byId(row.dataset.hid);
        const a = h && h.activities.find((x) => x.id === row.dataset.aid);
        if (!a) return;
        if (b.dataset.ag === "edit") return activityDialog(h, a);
        if (b.dataset.ag === "open") { setView("map"); select(h.id, true); }
        return;
      }
      if (row) {
        const h = byId(row.dataset.hid);
        const p = h && h.planned.find((x) => x.id === row.dataset.pid);
        if (!h || !p) return;
        if (b.dataset.ag === "done") return activityDialog(h, null, p);
        if (b.dataset.ag === "edit") return plannedDialog(h, p);
        if (b.dataset.ag === "open") { setView("map"); select(h.id, true); }
        return;
      }
      const a = state.agenda;
      if (b.dataset.ag === "prev" || b.dataset.ag === "next") {
        // Via Date, zodat december → januari het jaar meeneemt.
        const d = new Date(a.y, a.m + (b.dataset.ag === "next" ? 1 : -1), 1);
        state.agenda = { ...a, y: d.getFullYear(), m: d.getMonth(), day: "" };
      } else if (b.dataset.ag === "today") {
        const d = new Date();
        state.agenda = { ...a, y: d.getFullYear(), m: d.getMonth(), day: "" };
      } else if (b.dataset.ag === "clear") {
        state.agenda = { ...a, day: "" };
      } else return;
      return renderAgenda();
    }
    const cell = e.target.closest("[data-day]");
    if (!cell) return;
    // Dezelfde dag opnieuw aantikken toont weer de hele maand.
    state.agenda = { ...state.agenda, day: state.agenda.day === cell.dataset.day ? "" : cell.dataset.day };
    renderAgenda();
  });

  // De keuzes boven het logboek. Wat het met de kaart deelt gaat naar
  // state.filter, en dan moeten de zijbalk, de lijst en de kaart mee.
  agendaView.addEventListener("change", (e) => {
    const el = e.target;
    const d = el.dataset;
    const toggle = (list, v) => (el.checked ? [...list, v] : list.filter((x) => x !== v));
    if (d.filter) {
      state.filter[d.filter] = toggle(state.filter[d.filter], d.value);
      renderFilters();
      renderList();
      renderMarkers();
      renderKpis();
    } else if (d.logPick) {
      state.log[d.logPick] = toggle(state.log[d.logPick], d.value);
    } else if ("logPeriod" in d) {
      state.log.period = el.value;
    } else return;
    state.log.limit = LOG_STEP;
    renderLogBody();
  });
  agendaView.addEventListener("input", (e) => {
    if (!("logSearch" in e.target.dataset)) return;
    state.filter.query = e.target.value.trim();
    $("#search").value = state.filter.query;
    state.log.limit = LOG_STEP;
    renderLogBody();
    // De lijst en de kaart staan achter de agenda en hoeven niet bij elke
    // letter mee: dezelfde pauze als bij het zoekveld in de zijbalk.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { renderList(); renderMarkers(); }, 120);
  });
  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.action === "add") return $("#addHospitalBtn").click();
    state.ficheOpen = false;
    renderFiche();
    setView(b.dataset.view);
  });
  try {
    const saved = localStorage.getItem("followup-view");
    if (saved && !["stats", "agenda", "users"].includes(saved)) setView(saved);
  } catch (e) { /* privévenster */ }

  // ---------- gebruikers ----------
  // Wie mag wat. Alleen een beheerder komt hier: de menuknop staat verborgen
  // voor de rest, en de rij-beveiliging weigert de wijziging van ieder ander.
  //
  // Nieuwe gebruikers maak je hier niet aan. Dat vraagt de service-sleutel van
  // het Supabase-project, en die hoort niet in een publieke repo. Het scherm
  // zegt daarom waar het wél gebeurt.
  let users = [];

  async function loadUsers() {
    usersView.innerHTML = `<div class="u-head"><h2>${esc(t("users.title"))}</h2>
        <p class="muted">${esc(t("users.intro"))}</p></div>
      ${/* Zolang de lijst onderweg is: streepjes in de vorm van een rij. Er
           stond hier "Opslaan…", en opgeslagen wordt er op dat moment niets. */""}
      <div class="u-list" aria-busy="true">${'<div class="u-row skel"><b></b><span></span><span></span></div>'.repeat(4)}</div>`;
    try {
      // Eén plaats waar de vorm wordt rechtgezet, zodat de rest op een naam,
      // een rol en een lijst mag rekenen.
      users = (await store.users()).map((u) => ({
        id: u.id,
        name: u.name || "",
        role: ROLES.includes(u.role) ? u.role : "viewer",
        products: Array.isArray(u.products) ? u.products : [],
      }));
    } catch (e) {
      // De streepjes mogen niet blijven glanzen boven een foutmelding.
      const busy = usersView.querySelector("[aria-busy]");
      if (busy) busy.remove();
      usersView.insertAdjacentHTML("beforeend", `<p class="login-error">${esc(t("users.failed", { msg: e.message }))}</p>`);
      return;
    }
    renderUsers();
  }

  function renderUsers() {
    const meId = store.me().id;
    const row = (u) => `
      <div class="u-row">
        <div class="u-who">
          <input data-uid="${esc(u.id)}" data-ufield="name" value="${esc(u.name)}"
                 placeholder="${esc(t("users.name"))}" aria-label="${esc(t("users.name"))}">
          ${u.id === meId ? `<div class="u-mail">${esc(t("users.you"))}</div>` : ""}
        </div>
        <div class="u-role">
          <select data-uid="${esc(u.id)}" data-ufield="role" aria-label="${esc(t("users.role"))}">
            ${ROLES.map((r) => opt(r, t("role." + r), u.role)).join("")}
          </select>
          <small data-uhint="${esc(u.id)}">${esc(t("role." + u.role + ".hint"))}</small>
        </div>
        <div class="u-scope">
          <span class="field-label">${esc(t("users.products"))}</span>
          ${// "Alle producten" bovenaan is leeg bereik, en dat is iets anders
            // dan alle vakjes aanvinken: leeg betekent onbeperkt en neemt een
            // product dat er later bijkomt vanzelf mee, terwijl {EndoQ, Ainex}
            // ook later precies die twee blijft — en importeren uitschakelt.
            // Daarom staat die rij er als rij: dan is "alle" ook meteen de
            // tekst op de knop, zonder dat dit scherm er iets voor doet.
            pickBox([
              { attrs: `data-uid="${esc(u.id)}" data-uall="1"`, label: t("users.allProducts"),
                checked: !u.products.length, cls: "pick-all" },
              ...PRODUCTS.map((p) => ({
                attrs: `data-uid="${esc(u.id)}" data-uproduct="${esc(p)}"`, label: p,
                checked: u.products.includes(p),
              })),
            ], t("users.allProducts"))}
        </div>
      </div>`;
    usersView.innerHTML = `
      <div class="u-head">
        <h2>${esc(t("users.title"))}</h2>
        <p class="muted">${esc(t("users.intro"))}</p>
      </div>
      ${users.length
        ? `<div class="u-list">${users.map(row).join("")}</div>`
        : `<p class="muted">${esc(t("users.none"))}</p>`}`;
  }

  usersView.addEventListener("change", async (e) => {
    const el = e.target.closest("[data-uid]");
    if (!el) return;
    const u = users.find((x) => x.id === el.dataset.uid);
    if (!u) return;
    // Wat het was, om terug te kunnen zetten als de databank weigert.
    const before = { name: u.name, role: u.role, products: [...u.products] };
    if (el.dataset.ufield === "name") u.name = el.value.trim();
    else if (el.dataset.ufield === "role") u.role = el.value;
    else if (el.dataset.uall) u.products = [];
    else if (el.dataset.uproduct) {
      u.products = el.checked
        ? [...new Set([...u.products, el.dataset.uproduct])]
        : u.products.filter((x) => x !== el.dataset.uproduct);
    } else return;
    // "Alle producten" en de losse vakjes sluiten elkaar uit. Meteen
    // gelijkzetten, vóór de opslag: een vinkje dat JavaScript verzet stuurt
    // geen change, dus de uitklapper merkt het niet en syncPick() moet erbij.
    if (el.dataset.uall || el.dataset.uproduct) {
      for (const b of usersView.querySelectorAll(`[data-uid="${u.id}"][data-uproduct]`)) {
        b.checked = u.products.includes(b.dataset.uproduct);
      }
      const alle = usersView.querySelector(`[data-uid="${u.id}"][data-uall]`);
      if (alle) {
        alle.checked = !u.products.length;
        syncPick(alle.closest("details.pick"));
      }
    }
    try {
      await store.saveUser(u);
    } catch (err) {
      Object.assign(u, before);
      renderUsers();
      alert(t("users.failed", { msg: err.message }));
      return;
    }
    // Bijwerken zonder hertekenen: renderUsers() bouwt het scherm opnieuw op en
    // klapt daarmee de productkeuze dicht, midden in een reeks wijzigingen.
    toast(t("users.saved"));
    const hint = usersView.querySelector(`[data-uhint="${u.id}"]`);
    if (hint) hint.textContent = t("role." + u.role + ".hint");
    // Je eigen rol of bereik aangepast? Dan gelden er andere rechten dan de app
    // bij het starten heeft toegepast. Vroeger herlaadden we meteen, maar dat
    // gooit je bij élk vinkje terug naar de kaart. Nu vraagt de balk erom en
    // kies je zelf wanneer — met meerdere wijzigingen na elkaar één keer.
    if (u.id === store.me().id && (before.role !== u.role || String(before.products) !== String(u.products))) {
      showBanner(t("users.reloadNeeded"), true);
    }
  });

  $("#usersBtn").addEventListener("click", () => {
    if (!store.can.manageUsers) return toast(t("rights.notAllowed"));
    state.ficheOpen = false;
    renderFiche();
    setView("users");
  });

  // ---------- menu (⋯) ----------
  const menuList = $("#menuList");
  function toggleMenu(open) {
    menuList.hidden = !open;
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  }
  $("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(menuList.hidden); });
  // Licht, donker of het toestel. De keuze zelf bewaart theme.js; hier staat
  // alleen welke knop aan is. Het menu blijft open, zodat je meteen ziet wat
  // je koos en nog kunt wisselen.
  const theme = window.FollowUpTheme;
  const paintTheme = () => {
    for (const b of $("#themeSeg").querySelectorAll("[data-theme-set]")) {
      const on = b.dataset.themeSet === theme.get();
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  $("#themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-set]");
    if (!b) return;
    theme.set(b.dataset.themeSet);
    paintTheme();
  });
  paintTheme();
  menuList.addEventListener("click", (e) => { if (!e.target.closest(".menu__theme")) toggleMenu(false); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) toggleMenu(false); });
  init();
})();
