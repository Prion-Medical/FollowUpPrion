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
    PRODUCTS, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, LANGUAGES, COUNTRIES, REGIONS, REGION_KEYS, regionOf, ROLES,
    CMM_STATES, YES_NO, productKind, wantsQuantity, stagesFor, furthest, pipelineView,
    typesAmong, productsOf, productOf, familiesFor, wantsFamily, factsFor,
    esc, pickBox, syncPick, myProducts, productColor, merge3, deepEqual, setMain, mainContact,
  } = window.FollowUpDomain;
  // Wat de pagina doet zonder iets van ziekenhuizen te weten: zie ui.js.
  const { icon, leave, stay, leaving, softClose, ask, tell, rowTops, settleRows } = window.FollowUpUI;
  // Agendabestanden: zie ics.js. Het abonnement maakt dezelfde afspraken aan de
  // serverkant (supabase/functions/calendar).
  const Ics = window.FollowUpIcs;
  // Welk product staat standaard in een nieuw contactmoment of een planning:
  // dat van het ziekenhuis als er maar één is, anders het jouwe als jij er maar
  // één mag.
  const defaultProduct = (h) => (h.products.length === 1 ? h.products[0]
    : (myProducts().length === 1 ? myProducts()[0] : ""));

  // Scope-merken zijn eigennamen; enkel "other" is een sleutel met vertaling.
  const scopeLabel = (b) => (b === "other" ? t("scope.other") : b);
  // Benelux: west/zuid → oost/noord.
  // In welke regio je werkt, onthouden per browser zoals het thema. Het is
  // een filter als de andere, maar geen zoekvraag: "filters wissen" laat hem
  // staan, anders stond wie alleen de Benelux volgt na één klik weer tussen
  // de ziekenhuizen van de rest van de wereld.
  const REGION_KEY = "followup-regions";
  // Welke secties van het dossier dichtgeklapt staan, onthouden per browser:
  // wie veel producten heeft klapt dicht wat hij zelden nodig heeft, en dat
  // geldt dan voor elk ziekenhuis. Per sectie een sleutel; voor een product
  // is dat "product:" met zijn naam erachter.
  const SECTIONS_KEY = "followup-sections";
  const closedSections = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "[]");
      return new Set(Array.isArray(v) ? v.filter((k) => typeof k === "string") : []);
    } catch (e) { return new Set(); }
  })();
  function toggleSection(key) {
    if (closedSections.has(key)) closedSections.delete(key); else closedSections.add(key);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections])); } catch (e) { /* privévenster */ }
    return closedSections.has(key);
  }
  // Het begin van een sectie en haar kopje. Het kopje is zelf de knop: het
  // pijltje wijst naar rechts als de sectie dicht is en naar beneden als ze
  // openstaat. Wat er na de titel in het kopje komt (een teller, de knop om
  // iets toe te voegen) blijft ook bij een dichte sectie staan.
  const secOpen = (key) => `<div class="section${closedSections.has(key) ? " closed" : ""}" data-sec="${esc(key)}">`;
  const secHead = (key, title, rest = "") =>
    `<h3><button type="button" class="sec-toggle" data-sec-toggle="${esc(key)}" aria-expanded="${closedSections.has(key) ? "false" : "true"}">${icon("next")}<span>${esc(title)}</span></button>${rest}</h3>`;
  function savedRegions() {
    try {
      const v = JSON.parse(localStorage.getItem(REGION_KEY) || "[]");
      return Array.isArray(v) ? v.filter((r) => REGION_KEYS.includes(r)) : [];
    } catch (e) { return []; }
  }
  function keepRegions(list) {
    try {
      if (list.length) localStorage.setItem(REGION_KEY, JSON.stringify(list));
      else localStorage.removeItem(REGION_KEY);
    } catch (e) { /* privévenster */ }
  }

  // Geen enkel filter aan. Op één plaats: de begintoestand, de vraag of er
  // iets gefilterd is en "filters wissen" lezen alle drie dit lijstje.
  const noFilter = () => ({ statuses: [], products: [], countries: [], owners: [], derived: "", query: "" });
  const state = {
    // De gekozen regio's; leeg is overal. Bewust buiten filter: zie hierboven.
    regions: savedRegions(),
    db: { version: 1, hospitals: [] },
    // Zolang de gegevens onderweg zijn. Een scherm dat dan al openstaat toont
    // streepjes in plaats van "niets gepland" of nullen: leeg en nog-niet-er
    // zijn niet hetzelfde.
    loading: true,
    selectedId: null,
    // Elke filter is een lijst; leeg betekent geen beperking, dezelfde
    // betekenis als een leeg bereik op een gebruiker. derived is er één van
    // twee vragen over de opvolging en sluit zichzelf uit.
    filter: noFilter(),
    // Van welk ziekenhuis de lijst contactmomenten helemaal openstaat. Eén id
    // en geen vlag: zo klapt ze vanzelf weer dicht bij een ander ziekenhuis.
    actsOpen: null,
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
    // Welke maand de agenda toont, en eventueel één gekozen dag.
    // tab: "planned" is de agenda zelf, "log" het logboek ernaast.
    agenda: { y: new Date().getFullYear(), m: new Date().getMonth(), day: "", tab: "planned", assignees: [], whoOpen: false },
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
  // Een uur als 14:00. Enkel bij een gepland moment: een contactmoment heeft
  // een datum en geen uur.
  const timeOrEmpty = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(str(v)) ? str(v) : "");
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
  const inFilter = (r) => !state.filter.products.length || !productsOf(r).length || productsOf(r).some((p) => state.filter.products.includes(p));
  // "Te laat", "stil gevallen" en "demo gepland" volgen de productfilter, net
  // als de kleur: wie op Thyroid RFA filtert wil niet de achterstallige actie
  // van EndoQ zien. planned staat op datum, dus het eerste dat past is de
  // volgende actie — zonder filter is dat gewoon nextActionDate.
  // Een moment zonder datum kan niet te laat zijn: het eerste mét datum telt.
  function isOverdue(h) {
    const p = h.planned.find((x) => x.date && inFilter(x));
    return !!p && p.date < today();
  }
  // Te laat: een datum, en die is voorbij. Een moment zonder datum staat
  // klaar tot iemand het doet, en is dus nooit te laat.
  const isLate = (p) => !!p.date && p.date < today();
  // De plaats van een knop die er bij dit moment niet is (de download bij een
  // moment zonder datum). Leeg maar even breed, zodat afvinken en bewerken op
  // elke regel op dezelfde plek staan.
  const ICON_SLOT = '<span class="icon-btn icon-slot" aria-hidden="true"></span>';
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
  // Op datum, en op dezelfde dag eerst wat een uur heeft, in volgorde: wat
  // "ergens die dag" is, komt na wat om negen uur begint. Enkel om te tonen:
  // h.planned zelf blijft op datum, zoals fix_planned() in de databank het
  // ook legt, anders verschuift elke opslag de volgorde.
  // Een moment zonder datum heeft een lege datum en komt dus vanzelf vooraan.
  const byWhen = (a, b) => a.date.localeCompare(b.date) || (a.time || "99").localeCompare(b.time || "99");
  const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // nextAction en nextActionDate volgen uit het eerste geplande moment — ook
  // als dat er een zonder datum is: dat staat bovenaan, dus dat is wat er nu
  // te doen is. nextActionDate is dan leeg. Zo
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
    stay(el); // stond ze net weg te gaan, dan blijft ze
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => leave(el, () => { el.hidden = true; }, { ms: 160, shift: "translate(-50%, 6px)" }), 2600);
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
  // ---------- samen werken ----------
  // base is het document zoals we het laatst van de databank kennen: wat we
  // laadden, of wat we zelf met succes bewaarden. Daartegen meten we af wat
  // hier veranderd is en wat bij een collega (merge3 in domain.js).
  let base = null;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let saving = false;
  // Tijdens een opslag kwam er nog een wijziging bij: die gaat in een volgende.
  let saveAgain = false;
  // De pull die onderweg is. Wie er intussen ook om vraagt krijgt dezelfde:
  // een tweede naast de eerste zou op een verouderde basis samenvoegen, en
  // "bezet, ga maar door" liet de opslag zonder samenvoegen opnieuw proberen.
  let pulling = null;
  // Het samengevoegde document overnemen zonder de objecten te vervangen waar
  // een open dialoog of de fiche nog naar wijst: een ziekenhuis, een
  // contactpersoon of een moment dat al bestond blijft hetzelfde object en
  // krijgt alleen nieuwe inhoud. Anders bewaart een dialoog die openstond
  // zijn wijziging in een object dat niet meer in het document zit.
  function refill(target, src) {
    for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
    for (const [k, v] of Object.entries(src)) {
      if (k === "__proto__") continue;
      const old = target[k];
      if (Array.isArray(v) && Array.isArray(old) && v.every((r) => r && typeof r === "object" && r.id)) {
        const known = new Map(old.filter((r) => r && r.id).map((r) => [r.id, r]));
        target[k] = v.map((r) => (known.has(r.id) ? refill(known.get(r.id), r) : r));
      } else target[k] = v;
    }
    return target;
  }
  // Ophalen wat er nu staat en het hier erbovenop leggen. Geeft terug:
  //   "clean"    het document van de databank, hier is niets meer te bewaren
  //   "dirty"    samengevoegd, met wijzigingen van hier die nog weg moeten
  //   "conflict" allebei veranderden hetzelfde, of de toegang is veranderd
  function pull() {
    if (!pulling) pulling = doPull().finally(() => { pulling = null; });
    return pulling;
  }
  async function doPull() {
    // Zonder basis (het laden mislukte) valt niet te zeggen wat hier
    // veranderd is: dan zou alles van hier winnen van alles van daar.
    if (!base) return "conflict";
    const fresh = await store.peek();
    if (!fresh.sameAccess) return "conflict";
    fresh.db.version = Math.max(Number(fresh.db.version) || 1, DB_VERSION);
    fresh.db.hospitals.forEach(normalize);
    const conflicts = [];
    const merged = merge3(base, state.db, fresh.db, conflicts);
    if (conflicts.length) return "conflict";
    merged.hospitals.forEach(normalize);
    const mineLeft = !deepEqual(merged, fresh.db);
    refill(state.db, clone(merged));
    base = clone(fresh.db);
    store.accept(fresh.at);
    // Wie in de fiche aan het typen is, houdt zijn veld: wat hij typt staat
    // nog niet in het document en zou bij een hertekening weg zijn.
    const a = document.activeElement;
    if (a && a.closest && a.closest("#fiche") && a.matches("input, textarea, select")) {
      renderFilters(); renderKpis(); renderList(); renderMarkers();
    } else renderAll();
    return mineLeft ? "dirty" : "clean";
  }
  // Stil bijwerken. Wanneer je naar het tabblad terugkeert, en af en toe
  // terwijl het openstaat, vragen we of er iets veranderd is; zo ja, dan komt
  // het erbij zonder dat je er iets van merkt. Niet terwijl er een dialoog
  // openstaat of een opslag onderweg is: die regelen het zelf.
  async function refreshQuietly() {
    if (store.mode !== "supabase" || state.loading || document.hidden) return;
    if (saving || pulling || dirty || document.querySelector("dialog[open]")) return;
    // Ook niet terwijl je ergens typt, een lijstje openstaat of een speld
    // versleept: het scherm hertekenen zou dat onder je handen wegnemen. Het
    // komt een halve minuut later wel.
    // Een veld dat de focus nog heeft maar niet meer te zien is (in een
    // dialoog die al dicht is) telt niet: daar typt niemand.
    const a = document.activeElement;
    if (a && a.matches && a.matches("input, textarea, select") && a.offsetParent !== null) return;
    if (state.dragId || state.placing || document.querySelector("details.pick[open]")) return;
    try {
      if (!(await store.changed())) return;
      const result = await pull();
      if (result === "conflict") showBanner(t("save.conflict"), true, "warn");
    } catch (e) {
      // Geen netwerk, even geen databank: dit was maar een beleefdheid, de
      // eerstvolgende opslag merkt het vanzelf.
    }
  }
  document.addEventListener("visibilitychange", refreshQuietly);
  window.addEventListener("focus", refreshQuietly);
  setInterval(refreshQuietly, 30000);

  // "import" geldt voor één opslag: de eerstvolgende. Daarna weer gewoon.
  let saveMode = "save";
  async function save() {
    // Eén opslag tegelijk. Wat ondertussen verandert, gaat in de volgende.
    if (saving) { saveAgain = true; return; }
    const mode = saveMode;
    saveMode = "save";
    saving = true;
    try {
      // Iemand anders bewaarde ondertussen: ophalen, samenvoegen en opnieuw
      // proberen, zonder er de gebruiker mee lastig te vallen. Een paar keer,
      // want in de tijd van het ophalen kan er nog iemand bewaard hebben. Een
      // import voegen we niet samen: die zet bewust alles terug.
      for (let attempt = 0; ; attempt++) {
        const sent = clone(state.db);
        try {
          await store.save(state.db, mode);
          base = sent;
          break;
        } catch (e) {
          if (!(e instanceof store.ConflictError) || mode === "import" || attempt >= 3) throw e;
          if ((await pull()) === "conflict") throw e;
        }
      }
      dirty = saveAgain;
      showSaveState("save.saved");
    } catch (e) {
      // Een import die niet doorging mag later niet als gewone opslag worden
      // samengevoegd: dan zou de back-up half over de echte gegevens komen.
      // Zonder basis weigert pull() alles tot je herlaadt.
      if (mode === "import") base = null;
      showSaveState("save.failed", true);
      if (e instanceof store.ConflictError) {
        showBanner(t("save.conflict"), true, "warn");
      } else {
        const hint = store.mode === "local" ? t("save.errorLocal") : t("save.errorOnline");
        showBanner(t("save.errorBody", { hint, msg: e.message }));
      }
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; save(); }
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
  // tone: "error" (er ging iets mis), "warn" (opgelet) of "info" (ter info).
  // styles.css kleurt de balk ernaar; een mislukte opslag mag er niet uitzien
  // als een mededeling.
  function showBanner(msg, reload = false, tone = "error") {
    const b = $("#banner");
    b.dataset.tone = tone;
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
    if (can.noProfile) showBanner(t("rights.noProfile"), false, "warn");
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
  // Per persoon de producten waartoe hij beperkt is; leeg is onbeperkt. Enkel
  // om bij het toewijzen geen collega aan te bieden die het moment niet zou
  // zien.
  const peopleScope = new Map();
  async function loadPeople() {
    try {
      for (const u of await store.users()) {
        if (!u.name) continue;
        people.set(u.id, u.name);
        peopleScope.set(u.id, Array.isArray(u.products) ? u.products : []);
      }
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
  // Eén product in "product", of meer in "products": zie productsOf() in
  // domain.js. Wat er staat blijft in zijn vorm; hier wordt niets omgezet,
  // anders gaf laden en opslaan een ander document terug.
  function productShape(r) {
    if (Array.isArray(r.products)) {
      r.products = [...new Set(r.products.filter((p) => typeof p === "string" && p))];
      delete r.product;
    } else r.product = str(r.product);
  }
  // Een aantal hoort bij één product: gaat het moment over meer, dan is er
  // geen aantal.
  const wantsNumber = (type, r) => productsOf(r).length <= 1 && wantsQuantity(type, productOf(r));
  // De soort binnen het product (bij stents). Het veld staat er alleen als
  // er een gekozen is: een lege waarde bij elk ouder moment zou wie als
  // eerste opslaat de laatste bewerker van het hele logboek maken.
  function familyShape(r) {
    const p = productOf(r);
    if (wantsFamily(r.type, p) && familiesFor(p).includes(r.family)) r.family = str(r.family);
    else delete r.family;
  }
  function normalizeActivity(a) {
    a.id = str(a.id) || uid();
    a.type = ACT_TYPE_KEYS.includes(a.type) ? a.type : "other";
    a.date = dateOrEmpty(a.date);
    productShape(a);
    a.contactId = str(a.contactId);
    a.note = str(a.note);
    a.rooms = wantsNumber(a.type, a) ? numOrNull(a.rooms) : null;
    familyShape(a);
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
    productShape(p);
    p.contactId = str(p.contactId);
    p.note = str(p.note);
    familyShape(p);
    // Aan wie het moment is toegewezen. Het veld staat er alleen als iemand
    // gekozen is: schreven we bij elk ouder moment een lege waarde, dan zou
    // wie als eerste opslaat de laatste bewerker van de hele agenda worden.
    if (str(p.assignee)) p.assignee = str(p.assignee); else delete p.assignee;
    // Een uur is er alleen als iemand het invulde, om dezelfde reden: een leeg
    // veld bij elk ouder moment zou het hele rooster als gewijzigd opslaan.
    if (timeOrEmpty(p.time)) p.time = timeOrEmpty(p.time); else delete p.time;
    stampFields(p);
    return p;
  }
  // Voor wie een gepland moment is. Zonder toewijzing is dat wie het invoerde:
  // wie iets plant, volgt het bijna altijd ook op, en zo werkt de filter in de
  // agenda meteen voor alles wat er al stond.
  const assigneeOf = (p) => p.assignee || p.createdBy || "";
  // De gegevens van een product per ingreep. Ze staan in de rij van dat
  // product in h.pipeline en niet in een blok op het ziekenhuis zoals unit:
  // Thyroid RFA en Fibroid RFA hebben elk hun eigen goedkeuring, prioriteit en
  // concurrent in hetzelfde ziekenhuis, en zo vallen ze vanzelf binnen de
  // productmuur — de databank schermt die rijen al af per product.
  // Welke er bij een product horen zegt factsFor() in domain.js: bij stents
  // alleen de notitie. Wat er niet bij hoort krijgt ook geen
  // lege sleutel.
  function normalizeFacts(e, p) {
    const has = (k) => factsFor(p).includes(k);
    if (has("cmm")) e.cmm = CMM_STATES.includes(e.cmm) ? e.cmm : "";
    if (has("prio")) e.prio = [1, 2, 3].includes(Number(e.prio)) ? Number(e.prio) : null;
    if (has("doesAlready")) e.doesAlready = YES_NO.includes(e.doesAlready) ? e.doesAlready : "";
    if (has("currentSystem")) e.currentSystem = str(e.currentSystem);
    if (has("notes")) e.notes = str(e.notes);
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
      if (productKind(p) === "procedure") normalizeFacts(e, p);
    }
    const eerste = !Object.keys(h.pipeline).length;
    for (const p of h.products) {
      if (h.pipeline[p]) continue;
      const contacted = h.activities.some((a) => productsOf(a).includes(p));
      const e = eerste ? { stage: h.stage, status: h.status, owner: "" }
        : { stage: contacted ? "first_contact" : "prospect", status: contacted ? "orange" : "red", owner: "" };
      // Een fase die dit product niet kent, schuift naar de dichtste die het
      // wel kent: allebei liggen ze net voor of net na de evaluatie.
      if (!stagesFor(p).includes(e.stage)) e.stage = "evaluation";
      if (productKind(p) === "procedure") normalizeFacts(e, p);
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
    // Alleen bij een gepland moment, en alleen als het voor iemand anders is
    // dan jij of dan wie het invoerde: anders staat er op elke regel een naam
    // die niets zegt.
    // Een account dat niet meer bestaat is "?", niet niets: anders lijkt het
    // moment van wie het invoerde.
    const to = r.assignee && r.assignee !== store.me().id && r.assignee !== r.createdBy && (personName(r.assignee) || "?");
    return [withType && t("act." + r.type), productsOf(r).join(" + "), r.family && t("family." + r.family), c && c.name,
      r.rooms ? `${r.rooms} ${t(productKind(productOf(r)) !== "procedure" ? (r.rooms === 1 ? "act.room" : "act.rooms") : r.type === "procedure" ? "act.used" : "act.units")}` : "",
      to && t("for", { name: to }),
      by && t("by", { name: by })].filter(Boolean).join(" · ");
  }
  // De contactmomenten als CSV, recentste eerst: voor de export van alles en
  // voor "CSV van deze keuze" in het logboek.
  function activitiesCsv(items) {
    // De kolom met de soort staat er alleen voor wie een product heeft dat
    // soorten kent.
    const withFamily = myProducts().some((p) => familiesFor(p).length);
    return csv([
      [t("col.date"), t("col.hospital"), t("col.type"), t("col.product"), ...(withFamily ? [t("col.family")] : []), t("col.contact"), t("col.quantity"), t("col.note"), t("col.addedBy")],
      ...[...items].sort((x, y) => y.a.date.localeCompare(x.a.date))
        .map(({ h, a }) => [a.date, h.name, t("act." + a.type), productsOf(a).join(", "), ...(withFamily ? [a.family ? t("family." + a.family) : ""] : []),
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
    // Jezelf vooraan: dat is de keuze die je het vaakst maakt. De rest op naam.
    return [...list].sort((a, b) => (b[0] === me.id) - (a[0] === me.id) || a[1].localeCompare(b[1]));
  }
  // Een naam in een keuzelijst, met erbij wie jij bent. Alleen in lijsten
  // waar je kiest: naast een contactmoment staat gewoon de naam.
  const personLabel = (id) => {
    const name = personName(id);
    return name && id === store.me().id ? `${name} ${t("me.suffix")}` : name;
  };
  // Een id dat we niet (meer) kennen blijft als keuze staan, anders wist een
  // opslag het.
  // Aan wie je een gepland moment kunt toewijzen: wie het product van dat
  // moment mag zien. Zonder product is dat iedereen. Een keuze, geen muur: de
  // databank verbergt het moment sowieso voor wie het product niet heeft.
  // products: de producten van het moment. Wie er minstens één van heeft,
  // ziet het moment en kan het dus opvolgen.
  function assigneeOptions(products, current) {
    const list = owners().filter(([id]) => {
      const scope = id === store.me().id ? (store.can.products || []) : (peopleScope.get(id) || []);
      return !products.length || !scope.length || products.some((p) => scope.includes(p));
    });
    if (current && !list.some(([id]) => id === current)) list.push([current, personName(current) || "?"]);
    // "—" alleen als er niemand bekend is (een moment van vóór de stempel):
    // anders zou het stilzwijgend "wie het invoerde" betekenen.
    return [...(current ? [] : [opt("", "—", "")]), ...list.map(([id, name]) => opt(id, personLabel(id) || name, current))].join("");
  }
  function ownerOptions(current) {
    const list = owners();
    if (current && !list.some(([id]) => id === current)) list.push([current, "?"]);
    return [opt("", "—", current), ...list.map(([id, name]) => opt(id, personLabel(id) || name, current))].join("");
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
    // Op datum, en wat geen datum heeft vooraan: dat staat klaar tot iemand
    // het doet. Dezelfde volgorde als fix_planned() in de databank.
    h.planned.sort((a, b) => a.date.localeCompare(b.date));
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
  // De regio's waar je naar kijkt: de gekozen, of allemaal. Daaruit volgen de
  // landen in de landenfilter en het stuk kaart waarop de app opent.
  // Een regio telt pas mee als er een ziekenhuis in ligt. De tabel in
  // domain.js mag dus vooruitlopen op de data: zolang alles in de Benelux
  // ligt is er geen regiofilter te zien en opent de kaart daar, en met het
  // eerste ziekenhuis elders komt de filter er vanzelf bij.
  const liveRegions = () => REGION_KEYS.filter((r) => state.db.hospitals.some((h) => regionOf(h.country) === r));
  // Een onthouden keuze voor een regio waar (nog) niets in ligt geldt niet:
  // de filter om ze uit te zetten staat er dan niet.
  const pickedRegions = () => { const live = liveRegions(); return live.length > 1 ? state.regions.filter((r) => live.includes(r)) : []; };
  function activeRegions() {
    const picked = pickedRegions();
    if (picked.length) return picked;
    const live = liveRegions();
    return live.length ? live : REGION_KEYS.slice(0, 1);
  }
  const activeCountries = () => activeRegions().flatMap((r) => REGIONS[r].countries);
  function regionBounds() {
    const b = activeRegions().map((r) => REGIONS[r].bounds);
    return [
      [Math.min(...b.map((x) => x[0][0])), Math.min(...b.map((x) => x[0][1]))],
      [Math.max(...b.map((x) => x[1][0])), Math.max(...b.map((x) => x[1][1]))],
    ];
  }
  // Eén regio in beeld: noem ze ("Hele Benelux"). Meer dan één: "Alle landen".
  const regionLabel = (one, many) => (activeRegions().length === 1
    ? t(one, { region: t("region." + activeRegions()[0]) }) : t(many));
  const map = L.map("map", { zoomControl: true }).fitBounds(regionBounds());
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
  $("#regionBtn").addEventListener("click", () => map.fitBounds(regionBounds()));

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
    const regions = pickedRegions();
    return state.db.hospitals.filter((h) =>
      (!regions.length || regions.includes(regionOf(h.country))) &&
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
    // Waar staat elke rij nu? Dat moet vóór het hertekenen gemeten worden;
    // zie rowTops() en settleRows() in ui.js.
    // De lijst meet alle rijen, ook onder de rand: het zijn er een veertigtal,
    // en zo glijdt een ziekenhuis dat je opzoekt van onderaf naar boven in
    // plaats van uit het niets op te komen.
    const before = rowTops(ul, "li[data-id]", listKey);
    if (!items.length) {
      // Staat er een filter aan, dan is dat bijna altijd de reden. Eén knop
      // zet ze allemaal uit, in plaats van vier uitklappers na te lopen.
      const filtered = Object.values(state.filter).some((v) => v.length);
      ul.innerHTML = `<li class="empty"><span>${esc(t("list.empty"))}</span>${filtered
        ? `<button class="btn small" data-clear-filters>${esc(t("list.clear"))}</button>` : ""}</li>`;
      settleList(ul, before);
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      // Met een productfilter het hoofdcontact van dat product, anders het eerste.
      const primary = state.filter.products.map((p) => mainContact(h, p)).find(Boolean) || (state.filter.products.length ? null : mainContact(h));
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
    settleList(ul, before);
  }
  const listKey = (li) => li.dataset.id;
  const settleList = (ul, before) => settleRows(ul, "li", listKey, before, ul.getBoundingClientRect().bottom);
  $("#list").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-filters]")) {
      Object.assign(state.filter, noFilter());
      $("#search").value = "";
      renderFilters();
      renderList();
      renderMarkers();
      renderKpis();
      return;
    }
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
    { key: "statuses",  leeg: () => t("filter.allStatuses"), items: () => STATUSES,  label: (k) => t("status." + k + ".short") },
    { key: "products",  leeg: () => t("filter.allProducts"), items: myProducts,      label: (p) => p },
    // Regio staat er pas als er in meer dan één ziekenhuizen liggen; de landen volgen de regio.
    { key: "regions",   leeg: () => t("filter.allRegions"), items: () => (liveRegions().length > 1 ? liveRegions() : []), label: (r) => t("region." + r) },
    { key: "countries", leeg: () => regionLabel("filter.wholeRegion", "filter.allCountries"), items: activeCountries, label: (c) => t("country." + c) },
    // Wie verantwoordelijk is. De lijst is die van de keuzelijst in de fiche:
    // iedereen met een account. Zonder namen (lokaal, zonder localUser) is er
    // niets om op te filteren en staat de uitklapper er niet.
    { key: "owners",    leeg: () => t("filter.allOwners"), items: () => owners().map(([id]) => id), label: personLabel, voor: () => t("field.owner") },
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
        checked: chosen(f.key).includes(k),
      })), f.leeg(), false, f.voor && f.voor())).join("");
    $("#regionBtn").textContent = regionLabel("btn.wholeRegion", "btn.allRegions");
    renderDerived();
  }
  // Regio woont naast de andere filters (state.regions), de rest in state.filter.
  const chosen = (key) => (key === "regions" ? state.regions : state.filter[key]);
  // Een vinkje in een van de uitklappers, in de zijbalk of boven het logboek.
  function setChosen(key, list) {
    if (key !== "regions") { state.filter[key] = list; return; }
    state.regions = list;
    keepRegions(list);
    // Een land buiten de gekozen regio's kan niet aangevinkt blijven: het
    // staat niet meer in de lijst en zou onzichtbaar alles wegfilteren.
    state.filter.countries = state.filter.countries.filter((c) => activeCountries().includes(c));
    map.fitBounds(regionBounds());
  }
  // De landenlijst hangt van de regio af, dus na een regiovinkje moeten de
  // uitklappers opnieuw getekend worden. Die van de regio zelf gaat daarna
  // weer open: je bent er nog in bezig.
  function redrawAfterRegion(root) {
    renderFilters();
    if (root !== $("#pickFilters")) renderLog();
    const box = root.querySelector('[data-filter="regions"]');
    const d = box && box.closest("details");
    if (d) d.open = true;
  }
  // Niet hertekenen bij elk vinkje: dan klapt de uitklapper dicht. Enkel de
  // lijst en de kaart dus; de samenvatting op de knop is het werk van de
  // uitklapper zelf.
  $("#pickFilters").addEventListener("change", (e) => {
    const box = e.target.closest("[data-filter]");
    if (!box) return;
    const f = FILTERS.find((x) => x.key === box.dataset.filter);
    const v = box.dataset.value;
    setChosen(f.key, e.target.checked
      ? [...chosen(f.key), v]
      : chosen(f.key).filter((x) => x !== v));
    if (f.key === "regions") redrawAfterRegion($("#pickFilters"));
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
    // Eén ring die uitdijt rond de gekozen speld, zodat je op een volle kaart
    // ziet welke het is. Alleen bij het kiezen, niet bij elke hertekening.
    const pin = document.querySelector("#map .pin.selected");
    if (pin) pin.classList.add("pulse");
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
    // Sluiten gaat zacht: het paneel schuift weg en is daarna pas verborgen.
    // De inhoud blijft tot dan staan (een leeg paneel zien wegschuiven is
    // lelijker dan niets), en pas daarna is de kaart zo breed als ze wordt.
    if (h && state.ficheOpen) {
      stay(el);
      el.hidden = false;
    } else if (!el.hidden && !leaving(el)) {
      leave(el, () => {
        el.hidden = true;
        if (!sel()) el.innerHTML = "";
        map.invalidateSize();
      }, { ms: 140, shift: window.matchMedia("(max-width: 760px)").matches ? "translateY(24px)" : "translateX(12px)" });
    }
    if (!h) { if (el.hidden) el.innerHTML = ""; return; }

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
          ${STATUSES.map((k) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" title="${esc(t("status." + k))}"><span><i class="dot ${k}"></i>${esc(t("status." + k + ".short"))}</span></button>`).join("")}
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

      ${secOpen("followup")}
        ${secHead("followup", t("section.followup"))}
        ${pipe.length ? pipe.map((p) => {
          const e = h.pipeline[p];
          return `<div class="pipe">
            <div class="pipe-head">
              <div class="pipe-name"><i class="dot ${esc(e.status)}"></i><b>${esc(p)}</b><span class="muted">${esc(t("status." + e.status + ".short"))}</span></div>
              <div class="status-pick">
                ${STATUSES.map((k) => `<button class="${k} ${e.status === k ? "active" : ""}" data-status="${k}" data-pproduct="${esc(p)}" title="${esc(t("status." + k))}"><span><i class="dot ${k}"></i>${esc(t("status." + k + ".short"))}</span></button>`).join("")}
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

      ${secOpen("planned")}
        ${secHead("planned", t("section.planned"), `${late ? ` <span class="badge">${esc(t("badge.late"))}</span>` : ""} <button class="btn small" data-act="add-planned">${esc(t("btn.addPlanned"))}</button>`)}
        ${h.planned.length ? `<ul class="timeline">${[...h.planned].sort(byWhen).map((p) => {
          // Dezelfde regel als in de agenda, zodat ook hier staat voor wie
          // het moment is.
          const sub = momentLine(h, p, false);
          return `<li class="${isLate(p) ? "late" : ""}">
            <div class="t-date">${esc(p.date ? fmtDate(p.date) : t("planned.noDate"))}${p.time ? `<span class="t-rel">${esc(p.time)}</span>` : ""}<span class="t-rel">${esc(relDays(p.date))}</span></div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill" style="background:${ACT_TYPES[p.type] || "#999"}"></span>${esc(t("act." + p.type))}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${p.note ? `<div class="t-note">${esc(p.note)}</div>` : ""}
            </div>
            <div class="t-acts">
              <button class="icon-btn" data-act="done-planned" data-id="${esc(p.id)}" title="${esc(t("btn.done.title"))}" aria-label="${esc(t("btn.done.title"))}">${icon("check")}</button>
              <button class="icon-btn" data-act="edit-planned" data-id="${esc(p.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
              ${p.date ? `<button class="icon-btn" data-act="ics-planned" data-id="${esc(p.id)}" title="${esc(t("btn.ics"))}" aria-label="${esc(t("btn.ics"))}">${icon("calendar")}</button>` : ICON_SLOT}
            </div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">${esc(t("empty.planned"))}</p>`}
      </div>

      ${secOpen("activities")}
        ${secHead("activities", t("section.activities"), ` <button class="btn small" data-act="add-activity">${esc(t("btn.addActivity"))}</button>`)}
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

      ${secOpen("contacts")}
        ${secHead("contacts", t("section.contacts"), ` <button class="btn small" data-act="add-contact">${esc(t("btn.addContact"))}</button>`)}
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

      ${secOpen("data")}
        ${secHead("data", t("section.data"))}
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
        const facts = factsFor(p);
        return `${secOpen("product:" + p)}
        ${secHead("product:" + p, p)}
        <p class="muted">${esc(t("unit.unknownOk"))}</p>
        <div class="grid">
          ${!facts.includes("cmm") ? "" : `<label class="field">${esc(t("rfa.cmm"))}
            <select ${fact("cmm")}>${[opt("", "—", e.cmm), ...CMM_STATES.map((k) => opt(k, t("rfa.cmm." + k), e.cmm))].join("")}</select>
          </label>`}
          ${!facts.includes("prio") ? "" : `<label class="field">${esc(t("rfa.prio"))}
            <select ${fact("prio")}>${[opt("", "—", String(e.prio ?? "")), ...[1, 2, 3].map((n) => opt(String(n), String(n), String(e.prio ?? "")))].join("")}</select>
          </label>`}
          ${!facts.includes("doesAlready") ? "" : `<label class="field">${esc(t("rfa.doesAlready"))}
            <select ${fact("doesAlready")}>${[opt("", "—", e.doesAlready), ...YES_NO.map((k) => opt(k, t("yn." + k), e.doesAlready))].join("")}</select>
          </label>`}
          ${!facts.includes("currentSystem") ? "" : `<label class="field">${esc(t("rfa.currentSystem"))}
            <input ${fact("currentSystem")} value="${esc(e.currentSystem)}" placeholder="${esc(t("rfa.currentSystem.ph"))}">
          </label>`}
          ${!facts.includes("notes") ? "" : `<label class="field full">${esc(t("rfa.notes"))}
            <textarea ${fact("notes")} rows="3">${esc(e.notes)}</textarea>
          </label>`}
        </div>
      </div>`;
      }).join("")}

      ${!endoFor(h) ? "" : `${secOpen("unit")}
        ${secHead("unit", t("section.unit"))}
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
      stageStatus(h.pipeline[d.pstage], h.activities.some((a) => productsOf(a).includes(d.pstage)));
      syncPipeline(h);
    } else if (d.powner && h.pipeline[d.powner]) {
      h.pipeline[d.powner].owner = el.value;
    } else if (d.fact && h.pipeline[d.factProduct]) {
      // normalizeFacts houdt de vaste sleutels en het getal in de hand.
      h.pipeline[d.factProduct][d.fact] = el.value;
      normalizeFacts(h.pipeline[d.factProduct], d.factProduct);
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
    // Het eerste ziekenhuis in een andere regio brengt de regiofilter mee.
    if (d.field === "country") renderFilters();
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
    // Een sectie open- of dichtklappen. Zonder hertekenen: alleen de klasse
    // wisselt, zodat wat je in een veld aan het typen was blijft staan.
    const sec = e.target.closest("[data-sec-toggle]");
    if (sec) {
      const dicht = toggleSection(sec.dataset.secToggle);
      sec.closest(".section").classList.toggle("closed", dicht);
      sec.setAttribute("aria-expanded", dicht ? "false" : "true");
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
        if (c.primary) c.primary = false; else setMain(h, c);
        scheduleSave();
        return renderAll();
      }
      case "add-activity": return activityDialog(h, null);
      case "edit-activity": return activityDialog(h, h.activities.find((a) => a.id === id));
      case "add-planned": return plannedDialog(h, null);
      case "edit-planned": return plannedDialog(h, h.planned.find((p) => p.id === id));
      case "ics-planned": return downloadIcs(h, h.planned.find((p) => p.id === id));
      // Afvinken: het geplande moment wordt een contactmoment. De dialoog staat
      // al ingevuld; het aantal kamers vragen we daar voor het eerst.
      case "done-planned": return activityDialog(h, null, h.planned.find((p) => p.id === id));
      case "place": return startPlacing(h.id);
      case "drag":
        state.dragId = state.dragId === h.id ? null : h.id;
        if (state.dragId) toast(t("map.dragHint"));
        return renderAll();
      case "delete":
        ask(t("confirm.deleteHospital", { name: h.name })).then((yes) => {
          if (!yes) return;
          state.db.hospitals = state.db.hospitals.filter((x) => x.id !== h.id);
          scheduleSave();
          renderFilters(); // de regiofilter hangt af van waar er ziekenhuizen liggen
          closeFiche();
        });
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
        // Eerst de eigen regio; voorrang aan wat de kaart toont, anders haar midden.
        // Niets gevonden? Dan pas wereldwijd zoeken.
        const c = map.getCenter();
        const [[south, west], [north, east]] = regionBounds();
        const inRegion = c.lng >= west && c.lat >= south && c.lng <= east && c.lat <= north;
        const [lat, lon] = inRegion ? [c.lat.toFixed(3), c.lng.toFixed(3)] : [((south + north) / 2).toFixed(3), ((west + east) / 2).toFixed(3)];
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
        let json = await ask(`${url}&bbox=${[west, south, east, north].join(",")}`);
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
  // De formulierdialoog sluit zacht (softClose in ui.js), langs elke weg: een
  // knop of Escape. Dit staat op de dialoog en loopt dus na de afhandeling op
  // het formulier zelf; hield die het sluiten al tegen, dan blijft hij open.
  $("#dialog").addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    softClose(e.currentTarget, e.submitter ? e.submitter.value : "");
  });
  $("#dialog").addEventListener("cancel", (e) => { e.preventDefault(); softClose(e.currentTarget); });
  // askDelete is de vraag die de knop "Verwijder" eerst stelt; een dialoog
  // zonder zo'n knop laat hem weg.
  function openDialog(html, onSubmit, askDelete) {
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
        // Eerst vragen. De dialoog blijft eronder openstaan: wie "Annuleer"
        // kiest, staat terug waar hij was in plaats van alles kwijt te zijn.
        e.preventDefault();
        ask(askDelete).then((yes) => {
          if (!yes) return;
          softClose(dlg, "delete");
          onSubmit(null, "delete");
        });
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
      const used = followed || h.contacts.some((c) => c.products.includes(p)) || h.activities.some((a) => productsOf(a).includes(p));
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
        if (rec.primary) setMain(h, rec);
        if (!c) h.contacts.push(rec);
        for (const p of rec.products) if (!h.products.includes(p)) h.products.push(p);
        syncProducts(h, had.filter((p) => !rec.products.includes(p)));
      }
      syncPipeline(h);
      scheduleSave();
      renderAll();
    }, c && t("confirm.deleteContact", { name: c.name }));
  }

  // De keuzelijst van soorten voor een product; zonder product die van de
  // producten waar dit account mee werkt. Een moment dat al een soort heeft
  // die hier niet (meer) wordt aangeboden, houdt haar: de lijst versmalt de
  // keuze, ze herschrijft niets.
  function typeOptions(products, current) {
    const keys = typesAmong(products, myProducts());
    return (current && !keys.includes(current) ? [current, ...keys] : keys).map((k) => opt(k, t("act." + k), current)).join("");
  }
  // De producten van een moment: vinkjes in dezelfde uitklapper als overal.
  // Meestal één, soms meer (een gesprek over twee producten tegelijk).
  const productMany = (chosen) => pickBox(myProducts().map((p) => ({
    attrs: `data-mproduct="${esc(p)}"`, label: p, checked: chosen.includes(p),
  })), "—");
  const pickedProducts = (form) => [...form.querySelectorAll("[data-mproduct]:checked")].map((x) => x.dataset.mproduct);
  // De keuze in het record zetten, in de vorm die erbij hoort: een lijst
  // zodra het er meer dan één zijn of het record al een lijst droeg, anders
  // gewoon de ene naam.
  function setProducts(rec, list) {
    if (list.length > 1 || Array.isArray(rec.products)) { rec.products = list; delete rec.product; }
    else rec.product = list[0] || "";
  }
  // Een ander product gekozen in de dialoog: de lijst volgt. Bestaat de
  // gekozen soort daar niet, dan valt de keuze terug op de eerste.
  function retype(select, products) {
    const keys = typesAmong(products, myProducts());
    const was = select.value;
    select.innerHTML = keys.map((k) => opt(k, t("act." + k), keys.includes(was) ? was : keys[0])).join("");
  }

  function activityDialog(h, a, plan) {
    // Een plan zonder datum krijgt er hier een: wat gebeurd is, gebeurde op
    // een dag. Vandaag, tot iemand iets anders kiest.
    const v = a || (plan ? { ...plan, date: plan.date || today(), rooms: "" } : {
      date: today(),
      type: "email",
      product: defaultProduct(h),
      contactId: (mainContact(h, defaultProduct(h)) || {}).id || "",
      rooms: "", note: "",
    });
    const had = productsOf(v);
    const form = openDialog(`
      <h2>${esc(a ? t("dlg.actEdit") : t("dlg.actNew"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("dlg.a.date"))}<input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field">${esc(t("dlg.a.type"))}
          <select name="type">${typeOptions(had, v.type)}</select>
        </label>
        <div class="field">${esc(t("dlg.a.product"))}${productMany(had)}</div>
        <label class="field">${esc(t("dlg.a.contact"))}
          <select name="contactId">${[opt("", "—", v.contactId), ...h.contacts.map((c) => opt(c.id, c.name, v.contactId))].join("")}</select>
        </label>
        <label class="field" id="roomsField"><span id="roomsLabel">${esc(t("dlg.a.rooms"))}</span><input type="number" min="0" name="rooms" value="${esc(v.rooms ?? "")}" placeholder="1"></label>
        <label class="field" id="familyField">${esc(t("dlg.a.family"))}<select name="family"></select></label>
        <p class="muted full" id="roomsHint">${esc(t("dlg.a.used.hint"))}</p>
        <label class="field full">${esc(t("dlg.a.note"))}<textarea name="note" rows="4" placeholder="${esc(t("dlg.a.note.ph"))}">${esc(v.note)}</textarea></label>
        <p class="muted full" id="noteHint">${esc(t("dlg.a.procedure.hint"))}</p>
      </div>
      ${stampLine(a)}
      <div class="actions">
        ${a ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        h.activities = h.activities.filter((x) => x.id !== a.id);
        syncRooms(h, a, null);
      } else {
        // Komt dit uit de agenda, dan erft het contactmoment het id van het
        // plan. De databank ziet dan dat p:<id> verdwijnt en a:<id> opduikt, en
        // weet dat dit afvinken is en geen verwijderen. Niets verwijst naar een
        // id van een gepland moment, dus hergebruiken kan veilig.
        const rec = a || { id: plan ? plan.id : uid() };
        const keuze = pickedProducts(form);
        const product = keuze.length === 1 ? keuze[0] : "";
        const wantsRooms = keuze.length <= 1 && wantsQuantity(data.type, product);
        // Toestand vóór de wijziging, om straks het verschil te kunnen toepassen.
        const before = a ? { type: rec.type, rooms: rec.rooms, product: productOf(rec) } : null;
        Object.assign(rec, {
          date: data.date, type: data.type, contactId: data.contactId,
          rooms: wantsRooms ? num(data.rooms) : null, note: data.note.trim(),
        });
        setProducts(rec, keuze);
        if (wantsFamily(data.type, product) && data.family) rec.family = data.family;
        else delete rec.family;
        stamp(rec, !a);
        if (!a) h.activities.push(rec);
        // Een contactmoment voor een product zet dat product bij het
        // ziekenhuis: anders is er geen opvolging om bij te werken.
        for (const p of productsOf(rec)) if (!h.products.includes(p)) h.products.push(p);
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
    }, t("confirm.deleteActivity"));
    // Het aantal hangt af van soort én product: kamers bij een abonnement,
    // bestelde stuks bij een product per ingreep. Het veld is hetzelfde, het
    // opschrift volgt het product.
    // De soorten volgen het product, en de soort binnen het product (bij
    // stents) staat er alleen waar ook het aantal staat.
    let familyFor = null;
    const sync = (e) => {
      const keuze = pickedProducts(form);
      const product = keuze.length === 1 ? keuze[0] : "";
      if (e && e.target.dataset.mproduct) retype(form.elements.type, keuze);
      const type = form.elements.type.value;
      const perPiece = productKind(product) === "procedure";
      const number = keuze.length <= 1 && wantsQuantity(type, product);
      $("#roomsField", form).hidden = !number;
      $("#roomsLabel", form).textContent = t(!perPiece ? "dlg.a.rooms" : type === "procedure" ? "dlg.a.used" : "dlg.a.quantity");
      $("#roomsHint", form).hidden = !(perPiece && number);
      $("#noteHint", form).hidden = type !== "procedure";
      const fam = form.elements.family;
      if (familyFor !== product) {
        const was = familyFor === null ? v.family || "" : fam.value;
        fam.innerHTML = [opt("", "—", was), ...familiesFor(product).map((k) => opt(k, t("family." + k), was))].join("");
        familyFor = product;
      }
      $("#familyField", form).hidden = !wantsFamily(type, product);
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
      contactId: (mainContact(h, defaultProduct(h)) || {}).id || "",
      note: "",
    };
    // Een nieuw moment is voor jezelf tot je iemand anders kiest; een bestaand
    // toont wie het nu opvolgt.
    const assignee = p ? assigneeOf(p) : store.me().id;
    const had = productsOf(v);
    // Lokaal zonder naam is er niemand om aan toe te wijzen: dan geen veld.
    const canAssign = owners().length > 0 || !!assignee;
    const form = openDialog(`
      <h2>${esc(p ? t("dlg.plannedEdit") : t("dlg.plannedNew"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("dlg.p.date"))}<input type="date" name="date" value="${esc(v.date)}"
          title="${esc(t("dlg.p.date.hint"))}"></label>
        <label class="field">${esc(t("dlg.p.time"))}<input type="time" name="time" value="${esc(v.time || "")}"
          title="${esc(t("dlg.p.time.hint"))}"></label>
        <label class="field">${esc(t("dlg.p.type"))}
          <select name="type">${typeOptions(had, v.type)}</select>
        </label>
        <div class="field">${esc(t("dlg.p.product"))}${productMany(had)}</div>
        <label class="field">${esc(t("dlg.p.contact"))}
          <select name="contactId">${[opt("", "—", v.contactId), ...h.contacts.map((c) => opt(c.id, c.name, v.contactId))].join("")}</select>
        </label>
        ${canAssign ? `<label class="field full">${esc(t("dlg.p.assignee"))}
          <select name="assignee">${assigneeOptions(had, assignee)}</select>
        </label>` : ""}
        <label class="field full" id="familyField">${esc(t("dlg.a.family"))}<select name="family"></select></label>
        <label class="field full">${esc(t("dlg.p.note"))}<textarea name="note" rows="3" placeholder="${esc(t("dlg.p.note.ph"))}">${esc(v.note)}</textarea></label>
      </div>
      ${stampLine(p)}
      <div class="actions">
        ${p ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        h.planned = h.planned.filter((x) => x.id !== p.id);
      } else {
        const rec = p || { id: uid() };
        Object.assign(rec, {
          date: dateOrEmpty(data.date), type: data.type,
          contactId: data.contactId, note: data.note.trim(),
        });
        // Zonder uur een hele dag in de agenda; met een uur een uur lang. Een
        // uur zonder dag zegt niets, dus dat valt weg.
        if (rec.date && timeOrEmpty(data.time)) rec.time = timeOrEmpty(data.time); else delete rec.time;
        const keuze = pickedProducts(form);
        setProducts(rec, keuze);
        // De soort stent kan al bij het plannen: bij het afvinken gaat ze mee.
        if (keuze.length === 1 && wantsFamily(data.type, keuze[0]) && data.family) rec.family = data.family;
        else delete rec.family;
        // Het veld komt er alleen bij als het moment voor iemand anders is dan
        // wie het invoerde: voor die persoon volgt het al uit de stempel. Zo
        // krijgt een moment dat je voor jezelf plant geen naam mee, en blijft
        // een ouder moment waar niemand aan de toewijzing kwam onaangeroerd.
        const chosen = canAssign ? data.assignee : "";
        if (chosen && chosen !== (p ? p.createdBy || "" : store.me().id)) rec.assignee = chosen;
        else delete rec.assignee;
        stamp(rec, !p);
        if (!p) h.planned.push(rec);
        h.planned.sort((a, b) => a.date.localeCompare(b.date));
      }
      syncNextAction(h);
      scheduleSave();
      renderAll();
    }, t("confirm.deletePlanned"));
    // Een ander product, andere collega's: de lijst volgt de keuze. Wie
    // gekozen was blijft staan als hij dat product ook heeft.
    // onchange en geen luisteraar: #dialogForm wordt hergebruikt, en een
    // luisteraar per geopende dialoog zou zich opstapelen (zie openDialog).
    let familyFor = null;
    const family = () => {
      const keuze = pickedProducts(form);
      const product = keuze.length === 1 ? keuze[0] : "";
      const fam = form.elements.family;
      if (familyFor !== product) {
        const was = familyFor === null ? v.family || "" : fam.value;
        fam.innerHTML = [opt("", "—", was), ...familiesFor(product).map((k) => opt(k, t("family." + k), was))].join("");
        familyFor = product;
      }
      $("#familyField", form).hidden = !wantsFamily(form.elements.type.value, product);
    };
    family();
    form.onchange = (e) => {
      const changed = !!e.target.dataset.mproduct;
      const keuze = pickedProducts(form);
      if (changed) retype(form.elements.type, keuze);
      family();
      const pick = form.elements.assignee;
      if (!pick || !changed) return;
      const was = pick.value;
      // Een collega die het nieuwe product niet heeft valt weg. Iemand die we
      // niet (meer) kennen blijft staan: over hem valt niets te zeggen, en een
      // ander product kiezen mag het moment niet stil aan jou toewijzen.
      const unknown = !!was && !owners().some(([id]) => id === was);
      pick.innerHTML = assigneeOptions(keuze, unknown ? was : "");
      const has = (id) => [...pick.options].some((o) => o.value === id);
      const next = has(was) ? was : has(store.me().id) ? store.me().id : "";
      const blank = pick.querySelector('option[value=""]');
      if (next && blank) blank.remove();
      pick.value = next;
    };
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
    // Gaat het over meer dan één product, dan beweegt elk van die rijen mee.
    const rows = myProducts().filter((p) => h.products.includes(p) && h.pipeline[p]);
    const named = productsOf(act).filter((p) => h.pipeline[p]);
    const targets = named.length ? named.map((p) => [h.pipeline[p], p])
      : rows.length === 1 ? [[h.pipeline[rows[0]], rows[0]]] : rows.length ? [] : [[h, ""]];
    for (const [x, p] of targets) {
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
      // bij een product per ingreep, waar niets geïnstalleerd wordt. Een
      // procedure waar een van ons bij stond is daar hetzelfde: het product is
      // gebruikt, dus het wordt geëvalueerd. Een klant blijft klant.
      if ((act.type === "demo" || act.type === "procedure") && ["prospect", "first_contact", "meeting", "demo_planned"].includes(x.stage)) {
        x.stage = productKind(p) === "procedure" ? "evaluation" : "demo_installed";
      }
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
    const perKamer = (a) => !!a && productKind(productOf(a)) === "subscription";
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
      renderFilters(); // de regiofilter hangt af van waar er ziekenhuizen liggen
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

  // Welke periode een export beslaat. Alleen de twee lijsten met een datum
  // luisteren ernaar: contactmomenten en geplande momenten. Een voorkeuze is
  // "sinds zoveel maanden", zonder einde: zo geeft ze van het logboek het
  // recente stuk en van de agenda wat onlangs te laat was plus alles wat nog
  // komt, en hoeft niemand na te denken over wat "de laatste drie maanden"
  // voor een planning zou betekenen. De keuze blijft staan tot je herlaadt.
  const EXPORT_PERIODS = { all: 0, m3: 3, m6: 6, y1: 12, custom: 0 };
  let exportPeriod = { period: "all", from: "", to: "" };
  function exportRange({ period, from, to }) {
    if (period === "custom") {
      const a = dateOrEmpty(from), b = dateOrEmpty(to);
      // Omgekeerd ingevuld is nog altijd duidelijk wat bedoeld is.
      return a && b && a > b ? [b, a] : [a, b];
    }
    const months = EXPORT_PERIODS[period] || 0;
    if (!months) return ["", ""];
    const d = new Date();
    // Naar de eerste van die maand en dan pas naar de dag, begrensd op de
    // lengte van die maand: drie maanden terug vanaf 31 mei is eind februari,
    // niet 3 maart.
    const s = new Date(d.getFullYear(), d.getMonth() - months, 1);
    s.setDate(Math.min(d.getDate(), new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate()));
    return [ymd(s.getFullYear(), s.getMonth(), s.getDate()), ""];
  }
  $("#exportBtn").addEventListener("click", () => {
    const form = openDialog(`
      <h2>${esc(t("dlg.export"))}</h2>
      <p class="muted">${esc(t("dlg.exportHint"))}</p>
      <div class="grid">
        <label class="field full">${esc(t("log.period"))}
          <select name="period">${Object.keys(EXPORT_PERIODS).map((k) => opt(k, t("export.period." + k), exportPeriod.period)).join("")}</select>
        </label>
        <label class="field" data-export-custom ${exportPeriod.period === "custom" ? "" : "hidden"}>${esc(t("export.from"))}<input type="date" name="from" max="9999-12-31" value="${esc(exportPeriod.from)}"></label>
        <label class="field" data-export-custom ${exportPeriod.period === "custom" ? "" : "hidden"}>${esc(t("export.to"))}<input type="date" name="to" max="9999-12-31" value="${esc(exportPeriod.to)}"></label>
      </div>
      <p class="muted">${esc(t("export.periodHint"))}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">${esc(t("export.hospitals"))}</button>
        <button class="btn" value="contacts">${esc(t("export.contacts"))}</button>
        <button class="btn" value="activities">${esc(t("export.activities"))}</button>
        <button class="btn" value="planned">${esc(t("export.planned"))}</button>
        ${endoAccount() ? `<button class="btn" value="units">${esc(t("export.units"))}</button>` : ""}
        <button class="btn" value="json">${esc(t("export.json"))}</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">${esc(t("btn.close"))}</button></div>`, (data, kind) => {
      const hs = state.db.hospitals;
      const d = today();
      exportPeriod = { period: Object.hasOwn(EXPORT_PERIODS, data.period) ? data.period : "all", from: data.from || "", to: data.to || "" };
      const [from, to] = exportRange(exportPeriod);
      // Een moment zonder datum hoort in geen enkele periode, en dus alleen
      // bij "alle datums".
      const inPeriod = (date) => (date ? (!from || date >= from) && (!to || date <= to) : !from && !to);
      // De periode in de bestandsnaam, zodat je later nog ziet wat erin zit.
      const span = from || to ? `${from || "begin"}--${to || d}` : d;
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
              ...factsFor(p).map((k) => `${t("rfa." + k)} ${p}`)])],
          ...hs.map((h) => [h.name, h.country && t("country." + h.country), h.sector && t("sector." + h.sector),
            t("status." + h.status), t("stage." + h.stage), h.products.join(", "), lastContact(h),
            countType(h, "demo"), ...(endoAccount() ? [countType(h, "installation"), h.unit.roomsInstalled ?? ""] : []),
            demoDate(h), h.nextAction, h.nextActionDate, h.contacts.filter((c) => c.primary).map((c) => c.name).join(" / "),
            h.address, h.createdAt, h.notes,
            h.network, h.sites,
            ...myProducts().flatMap((p) => {
              const e = h.products.includes(p) && h.pipeline[p];
              const facts = factsFor(p);
              if (!e) return ["", "", ...facts.map(() => "")];
              const shown = { cmm: e.cmm && t("rfa.cmm." + e.cmm), prio: e.prio ?? "", doesAlready: e.doesAlready && t("yn." + e.doesAlready), currentSystem: e.currentSystem, notes: e.notes };
              return [t("stage." + e.stage), personName(e.owner), ...facts.map((k) => shown[k])];
            })]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`contacts-${d}.csv`, csv([
          [t("col.hospital"), t("col.name"), t("col.dept"), t("col.role"), t("col.phone"), t("col.email"), t("col.language"), t("col.address"), t("col.product"), t("col.isPrimary"), t("col.notes")],
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.department && t("dept." + c.department), c.role,
            c.phone, c.email, c.language, c.address, c.products.join(" / "), c.primary ? t("col.yes") : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`activities-${span}.csv`, activitiesCsv(hs.flatMap((h) => h.activities.filter((a) => inPeriod(a.date)).map((a) => ({ h, a })))), "text/csv");
      } else if (kind === "planned") {
        // De agenda, eerst wat het eerst komt. Voor wie het is staat er
        // altijd: zonder toewijzing is dat wie het invoerde.
        download(`planned-${span}.csv`, csv([
          [t("col.date"), t("col.time"), t("col.hospital"), t("col.type"), t("col.product"), t("col.contact"), t("col.note"), t("dlg.p.assignee"), t("col.addedBy")],
          ...hs.flatMap((h) => h.planned.filter((p) => inPeriod(p.date)).map((p) => ({ h, p })))
            .sort((x, y) => byWhen(x.p, y.p) || x.h.name.localeCompare(y.h.name))
            .map(({ h, p }) => [p.date, p.time || "", h.name, t("act." + p.type), productsOf(p).join(", "),
              (h.contacts.find((c) => c.id === p.contactId) || {}).name, p.note, personName(assigneeOf(p)) || (p.assignee ? "?" : ""), personName(p.createdBy)]),
        ]), "text/csv");
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
    // De twee datumvelden staan er alleen bij een eigen periode.
    form.elements.period.addEventListener("change", (e) => {
      form.querySelectorAll("[data-export-custom]").forEach((el) => { el.hidden = e.target.value !== "custom"; });
    });
    // Enter in een datumveld zou het formulier indienen met de eerste knop en
    // zo ongevraagd het ziekenhuisoverzicht downloaden.
    for (const name of ["from", "to"]) {
      form.elements[name].addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    }
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
      if (!(await ask(t("import.confirm", { n: data.hospitals.length }), { ok: t("btn.continue") }))) return;
      data.hospitals.forEach(normalize);
      state.db = data;
      state.selectedId = null;
      saveMode = "import";
      scheduleSave();
      renderAll();
      fitAll();
      toast(t("import.done"));
    } catch (err) {
      tell(t("import.failed", { msg: err.message }));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
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
    // Het rooster, "te laat" en de lijst volgen alle drie de keuze "voor wie".
    const who = state.agenda.assignees;
    for (const h of state.db.hospitals) for (const p of h.planned) if (!who.length || who.includes(assigneeOf(p))) out.push({ h, p });
    return out.sort((a, b) => byWhen(a.p, b.p) || a.h.name.localeCompare(b.h.name));
  }

  // ---------- agenda-abonnementen ----------
  // Een gepland moment als afspraak. Dezelfde vorm als in het abonnement: de
  // soort, het product en het ziekenhuis als titel, het ziekenhuis en zijn
  // adres als plaats, en de nota. Geen contactpersoon — dat zijn gegevens van
  // een arts in de agenda van een derde partij.
  const icsEventOf = (h, p) => ({
    id: p.id, date: p.date, time: p.time || "", country: h.country,
    title: Ics.title(t("act." + p.type), productsOf(p), h.name),
    location: Ics.place(h.name, h.address),
    description: p.note,
  });
  // Eén moment als bestand: een kopie, die niet meeverandert als het plan
  // verandert. Daarvoor is het abonnement.
  function downloadIcs(h, p) {
    if (!h || !p) return;
    const name = `${p.date}-${h.name}`.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60);
    download(`${name || "followup"}.ics`, Ics.calendar([icsEventOf(h, p)], ""), "text/calendar;charset=utf-8");
  }

  const feedDate = (ts) => (ts ? new Date(ts).toLocaleDateString(I18N.locale, { day: "numeric", month: "short", year: "numeric" }) : "");
  const feedSummary = (f) => [
    t(f.mine ? "feeds.mine" : "feeds.everyone"),
    f.products && f.products.length ? f.products.join(", ") : t("feeds.allProducts"),
    String(f.lang || "nl").toUpperCase(),
  ].join(" · ");
  // Eén abonnement in een lijst. button is de knop om het stop te zetten: in
  // de dialoog een verzendknop, op het gebruikersscherm een gewone knop.
  const feedRow = (f, owner, button) => `<li class="feed-row">
      <div class="feed-what">
        <b>${esc(f.label || t("feeds.unnamed"))}</b>${owner ? ` <span class="muted">· ${esc(owner)}</span>` : ""}
        <span class="muted">${esc(feedSummary(f))}</span>
        <span class="muted">${esc(t("feeds.created", { date: feedDate(f.created_at) }))} · ${
          esc(f.last_used ? t("feeds.used", { date: feedDate(f.last_used) }) : t("feeds.neverUsed"))}</span>
      </div>
      ${button}
    </li>`;

  // Abonneren: een adres dat je agenda-app zelf ophaalt. De dialoog maakt er
  // een aan, toont het één keer, en lijst de abonnementen die je al hebt.
  function feedDialog() {
    if (!store.feeds) return tell(t("feeds.localOnly"));
    const products = myProducts();
    // Een tweede klik terwijl de eerste nog onderweg is, maakt geen tweede adres.
    let busy = false;
    const form = openDialog(`
      <h2>${esc(t("feeds.title"))}</h2>
      <p class="muted">${esc(t("feeds.intro"))}</p>
      <div class="feed-fresh" hidden></div>
      <h3 class="feed-h">${esc(t("feeds.new"))}</h3>
      <div class="grid">
        <label class="field full">${esc(t("feeds.label"))}<input name="label" maxlength="80" placeholder="${esc(t("feeds.label.ph"))}"></label>
        <label class="field">${esc(t("feeds.who"))}
          <select name="mine">${opt("1", t("feeds.mine"), "1")}${opt("0", t("feeds.everyone"), "1")}</select>
        </label>
        <label class="field">${esc(t("feeds.lang"))}
          <select name="lang">${opt("nl", "Nederlands", I18N.lang)}${opt("en", "English", I18N.lang)}</select>
        </label>
        ${products.length > 1 ? `<div class="field full">${esc(t("feeds.products"))}${pickBox([
          { attrs: `data-feed-all="1"`, label: t("feeds.allProducts"), checked: true, cls: "pick-all" },
          ...products.map((p) => ({ attrs: `data-feed-product="${esc(p)}"`, label: p, checked: false })),
        ], t("feeds.allProducts"))}</div>` : ""}
      </div>
      <p class="muted">${esc(t("feeds.delay"))}</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.close"))}</button>
        <button class="btn primary" value="create">${esc(t("feeds.create"))}</button>
      </div>
      <h3 class="feed-h">${esc(t("feeds.yours"))}</h3>
      <div class="feed-list"><p class="muted">${esc(t("feeds.loading"))}</p></div>`, (data, action) => {
      if (action === "create" && !busy) {
        busy = true;
        const chosen = [...form.querySelectorAll("[data-feed-product]:checked")].map((b) => b.dataset.feedProduct);
        store.feedCreate({ label: data.label.trim(), mine: data.mine === "1", products: chosen, lang: data.lang })
          .then((r) => { showFresh(store.feedUrl(r.secret)); form.elements.label.value = ""; return loadList(); })
          .catch((e) => tell(t("feeds.failed", { msg: e.message })))
          .finally(() => { busy = false; });
      } else if (action.startsWith("remove:")) {
        const id = action.slice(7);
        ask(t("feeds.confirmRemove"), { ok: t("feeds.remove") }).then((yes) => yes && store.feedRemove(id)
          .then(() => { toast(t("feeds.removed")); return loadList(); })
          .catch((e) => tell(t("feeds.failed", { msg: e.message }))));
      }
      return KEEP_OPEN;
    });
    // "Alle producten" en de losse vakjes sluiten elkaar uit, zoals op het
    // gebruikersscherm. Niets aangevinkt is weer alles.
    form.onchange = (e) => {
      const all = form.querySelector("[data-feed-all]");
      if (!all) return;
      const boxes = [...form.querySelectorAll("[data-feed-product]")];
      if (e.target === all) boxes.forEach((b) => { b.checked = false; });
      else if (e.target.dataset.feedProduct) all.checked = !boxes.some((b) => b.checked);
      if (!all.checked && !boxes.some((b) => b.checked)) all.checked = true;
      syncPick(all.closest("details.pick"));
    };
    // Het adres, één keer. De databank bewaart enkel een hash: wie het hier
    // niet kopieert, maakt later een nieuw.
    function showFresh(url) {
      const box = $(".feed-fresh", form);
      const webcal = url.replace(/^https:/, "webcal:");
      const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
      box.innerHTML = `
        <p><b>${esc(t("feeds.ready"))}</b></p>
        <div class="feed-url">
          <input readonly value="${esc(url)}" aria-label="${esc(t("feeds.address"))}">
          <button type="button" class="btn small" data-feed-copy>${icon("copy")} ${esc(t("feeds.copy"))}</button>
        </div>
        <p class="feed-warn">${esc(t("feeds.secret"))}</p>
        ${/* Per agenda hoe je het toevoegt, dichtgeklapt: wie Outlook gebruikt,
             hoeft de stappen voor Apple niet te lezen. name maakt er één groep
             van, zodat er telkens één openstaat. Gewone <details>, geen
             .pick: de luisteraar in domain.js laat ze dus met rust. */""}
        <div class="feed-how">
          ${[
            ["apple", `<a class="btn small" href="${esc(webcal)}">${icon("calendar")} ${esc(t("feeds.openApp"))}</a>`],
            ["google", `<a class="btn small" href="${esc(google)}" target="_blank" rel="noopener noreferrer">${esc(t("feeds.openGoogle"))}</a>`],
            ["outlook", ""],
          ].map(([k, button]) => `<details name="feed-how">
            <summary>${icon("next")}<span>${esc(t("feeds.how." + k))}</span></summary>
            <div class="feed-how-body">
              ${button ? `<p>${button}</p>` : ""}
              <ol>${t("feeds.how." + k + ".steps").split("\n").map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
            </div>
          </details>`).join("")}
        </div>`;
      box.hidden = false;
      const input = $("input", box);
      $("[data-feed-copy]", box).onclick = () => {
        input.select();
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
          .then(() => toast(t("feeds.copied")), () => { document.execCommand("copy"); toast(t("feeds.copied")); });
      };
      input.focus();
      input.select();
    }
    function loadList() {
      const list = $(".feed-list", form);
      return store.feedList().then((feeds) => {
        list.innerHTML = feeds.length ? `<ul class="feed-rows">${feeds.map((f) => feedRow(f, "",
          `<button class="btn small danger" value="remove:${esc(f.id)}" formnovalidate>${esc(t("feeds.remove"))}</button>`)).join("")}</ul>`
          : `<p class="muted">${esc(t("feeds.none"))}</p>`;
      }, (e) => { list.innerHTML = `<p class="login-error">${esc(t("feeds.failed", { msg: e.message }))}</p>`; });
    }
    loadList();
  }

  // Voor wie: dezelfde uitklapper als de filters in het logboek en de zijbalk,
  // met jezelf vooraan. "Gepland voor" en niet "Toegewezen aan": dat laatste
  // is wie een product bij een ziekenhuis opvolgt, en die filter staat op het
  // andere tabblad van deze pagina. Twee keer hetzelfde woord voor twee
  // verschillende dingen las als één filter. Zonder namen (lokaal zonder naam) valt er niets te
  // kiezen en staat er niets.
  function agendaAssignee() {
    const list = owners();
    if (!list.length) return "";
    const open = state.agenda.whoOpen;
    state.agenda.whoOpen = false;
    return `<div class="s-filters">${pickBox(list.map(([id]) => ({
      attrs: `data-ag-who data-value="${esc(id)}"`, label: personLabel(id), checked: state.agenda.assignees.includes(id),
    })), t("agenda.forAnyone"), open, t("dlg.p.assignee"))}</div>`;
  }

  function agendaRow({ h, p }) {
    const sub = momentLine(h, p, true);
    const when = p.date ? new Date(p.date + "T00:00:00").toLocaleDateString(I18N.locale, { weekday: "short", day: "numeric", month: "short" })
      : t("planned.noDate");
    return `<li class="ag-row ${isLate(p) ? "late" : ""}" data-hid="${esc(h.id)}" data-pid="${esc(p.id)}">
      <div class="ag-date"><b${p.date ? "" : ' class="nodate"'}>${esc(when)}</b><span>${esc(p.time ? `${p.time} · ${relDays(p.date)}` : relDays(p.date))}</span></div>
      <div class="ag-body">
        <div class="ag-name">${esc(h.name)}</div>
        <div class="ag-sub"><span class="type-pill" style="background:${ACT_TYPES[p.type] || "#999"}"></span>${esc(sub)}</div>
        ${p.note ? `<div class="ag-note">${esc(p.note)}</div>` : ""}
      </div>
      <div class="ag-acts">
        <button class="icon-btn" data-ag="done" title="${esc(t("btn.done.title"))}" aria-label="${esc(t("btn.done.title"))}">${icon("check")}</button>
        <button class="icon-btn" data-ag="edit" title="${esc(t("btn.edit"))}" aria-label="${esc(t("btn.edit"))}">${icon("edit")}</button>
        ${p.date ? `<button class="icon-btn" data-ag="ics" title="${esc(t("btn.ics"))}" aria-label="${esc(t("btn.ics"))}">${icon("calendar")}</button>` : ICON_SLOT}
        <button class="icon-btn" data-ag="open" title="${esc(t("agenda.open"))}" aria-label="${esc(t("agenda.open"))}">${icon("arrow")}</button>
      </div>
    </li>`;
  }

  function renderAgenda() {
    // Zolang de gegevens onderweg zijn tekent de agenda haar eigen streepjes,
    // wie haar ook oproept: een lege agenda zou "niets gepland" zeggen.
    if (state.loading) { agendaView.innerHTML = skelAgenda(); return; }
    if (state.agenda.tab === "log") return renderLog();
    const { y, m, day } = state.agenda;
    const items = plannedAll();
    const td = today();
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const overdue = items.filter((x) => isLate(x.p));
    // Zonder datum: niet in het rooster, wel bovenaan de lijst, tot het gedaan is.
    const undated = items.filter((x) => !x.p.date);
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
        ${agendaAssignee()}
        ${store.feeds ? `<button class="btn small" data-ag="subscribe" title="${esc(t("feeds.button.title"))}">${icon("calendar")} ${esc(t("feeds.button"))}</button>` : ""}
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
      ${items.length ? "" : `<p class="muted">${esc(t(state.agenda.assignees.length ? "agenda.noneFor" : "agenda.none"))}</p>`}
      ${overdue.length && !day && !past ? `<div class="ag-block">
        <h3 class="ag-h">${esc(t("agenda.overdue"))} <span class="badge">${overdue.length}</span></h3>
        <ul class="ag-list">${overdue.map(agendaRow).join("")}</ul>
      </div>` : ""}
      ${undated.length && !day ? `<div class="ag-block undated">
        <h3 class="ag-h">${esc(t("agenda.undated"))} <span class="badge neutral">${undated.length}</span></h3>
        <ul class="ag-list">${undated.map(agendaRow).join("")}</ul>
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
          const hay = [place, c && c.name, t("act." + a.type), productsOf(a).join(" "), a.note].join(" ").toLowerCase();
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
    // Zoals in de lijst van ziekenhuizen: een rij die blijft schuift naar haar
    // nieuwe plek, een nieuwe komt zacht op. De weekkopjes doen mee, anders
    // springen zij terwijl de rijen eronder glijden.
    const LOG_ROWS = "h3.ag-h, li.ag-row, p.muted";
    const logKey = (el) => el.dataset.aid || "kop:" + el.textContent;
    const before = rowTops(body, LOG_ROWS, logKey, window.innerHeight);
    const settle = () => settleRows(body, LOG_ROWS, logKey, before, window.innerHeight);
    if (!items.length) { body.innerHTML = `<p class="muted">${esc(t("log.empty"))}</p>`; settle(); return; }
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
    settle();
  }
  // De soorten in de filter: die van de producten waarop gefilterd is, of van
  // je eigen producten. Wat al aangevinkt staat blijft erbij, anders valt een
  // vinkje weg dat nog wel filtert.
  function logTypes() {
    const offered = typesOffered(state.filter.products.length ? state.filter.products : myProducts());
    return ACT_TYPE_KEYS.filter((k) => offered.includes(k) || state.log.types.includes(k));
  }
  const logPick = (key, items, label, leeg, voor) => pickBox(items.map((k) => ({
    attrs: `data-log-pick="${esc(key)}" data-value="${esc(k)}"`, label: label(k), checked: state.log[key].includes(k),
  })), leeg, false, voor);
  const logTypesPick = () => logPick("types", logTypes(), (k) => t("act." + k), t("log.allTypes"));
  function renderLog() {
    const L = state.log;
    const only = L.hospitalId && byId(L.hospitalId);
    if (L.hospitalId && !only) clearLogHospital();
    const pick = logPick;
    agendaView.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("agenda.title"))}</h2>
        ${agendaTabs()}
      </div>
      <div class="s-filters log-filters">
        ${// Eén manier voor de hele rij: wat een veld filtert staat ín het
          // veld, niet ervoor. De periodes zeggen zelf wat ze zijn; "Ingevoerd
          // door" en "Toegewezen aan" blijven erbij staan als er namen gekozen
          // zijn, want een naam alleen zegt niet waarvoor hij staat.
          ""}<label><select data-log-period aria-label="${esc(t("log.period"))}">${LOG_PERIODS.map((p) => opt(p, t("log.period." + p), L.period)).join("")}</select></label>
        ${only ? "" : FILTERS.filter((f) => f.key !== "statuses" && f.items().length).map((f) => `<label>${pickBox(f.items().map((k) => ({
          attrs: `data-filter="${esc(f.key)}" data-value="${esc(k)}"`, label: f.label(k), checked: chosen(f.key).includes(k),
        })), f.leeg(), false, f.voor && f.voor())}</label>`).join("")}
        <label data-log-types>${logTypesPick()}</label>
        ${owners().length ? `<label>${pick("authors", owners().map(([id]) => id), personLabel, t("log.anyAuthor"), t("log.author"))}</label>` : ""}
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
  // ---------- wat er staat zolang de gegevens onderweg zijn ----------
  // Dezelfde streepjes als de lijst in index.html, in de vorm van het scherm
  // dat komt: zo staat de indeling er meteen en verspringt er weinig wanneer
  // de echte inhoud arriveert. De glans komt van aria-busy (styles.css).
  const skelRows = (n) => `<ul class="ag-list" aria-busy="true">${'<li class="ag-row skel"><div><b></b><span></span></div></li>'.repeat(n)}</ul>`;
  const skelAgenda = () => `
    <div class="s-head"><h2>${esc(t("agenda.title"))}</h2>${agendaTabs()}</div>
    <div class="skel-box ${state.agenda.tab === "log" ? "skel-filters" : "skel-cal"}" aria-busy="true"></div>
    ${skelRows(state.agenda.tab === "log" ? 6 : 3)}`;
  const skelStats = () => `
    <div class="s-head"><h2>${esc(t("nav.stats"))}</h2></div>
    <div class="s-tiles" aria-busy="true">${'<div class="s-tile skel"><span></span><b></b></div>'.repeat(5)}</div>
    <div class="skel-box skel-card" aria-busy="true"></div>`;
  // Met een knop om te sluiten: op een telefoon bedekt de fiche het hele
  // scherm, en wie op een trage verbinding niet wil wachten moet eruit kunnen.
  const skelFiche = () => `<div class="fiche-skel-head"><button class="icon-btn" data-skel-close title="${esc(t("btn.close"))}" aria-label="${esc(t("btn.close"))}">${icon("close")}</button></div>
    <div class="fiche-skel skel" aria-busy="true">
      <b class="skel-title"></b>${"<span></span><b></b><span></span><span></span>".repeat(4)}
    </div>`;

  function renderAll() {
    if (!statsView.hidden && !state.loading) window.FollowUpStats.render(state.db, statsView, scheduleSave, pickedRegions());
    if (!agendaView.hidden) renderAgenda();
    if (!usersView.hidden) renderUsers();
    renderFilters();
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
      if (Number(state.db.version) > DB_VERSION) showBanner(t("save.newerVersion"), false, "warn");
      state.db.version = Math.max(Number(state.db.version) || 1, DB_VERSION);
      state.db.hospitals.forEach(normalize);
      // Wat we nu van de databank kennen; daartegen meten we later af wat hier
      // veranderde en wat bij een collega.
      base = clone(state.db);
      // read_state geeft de rol en het bereik mee waarmee dit document is
      // uitgelezen; is daar iets aan veranderd, dan kloppen de knoppen nu pas.
      applyRights();
      showSaveState("save.saved");
      if (empty) offerSeed();
    } catch (e) {
      showBanner(e.message);
    }
    if (store.mode === "supabase") $("#logoutBtn").hidden = false;
    // Geladen of mislukt: de streepjes maken plaats voor wat er is.
    state.loading = false;
    const place = early && document.body.dataset.view === early.view ? early.place : null;
    // De fiche alleen als haar streepjes er nog staan: anders is ze gesloten.
    const open = place && (!place.hospital || $("#fiche .fiche-skel")) ? restoreSelection(place) : null;
    renderAll();
    map.invalidateSize();
    // Alles in beeld brengen is voor wie vers binnenkomt; wie herlaadt houdt
    // de kaart waar ze stond.
    if (!placeAt(place)) fitAll();
    restoreView(place, open);
  }

  // Lege online databank: startlijst laden of een back-up importeren.
  function offerSeed() {
    const b = $("#banner");
    b.dataset.tone = "info";
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
        tell(t("seed.missing"));
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
    if (view === "stats" && state.loading) {
      statsView.innerHTML = skelStats();
    } else if (view === "stats") {
      // Bij het binnenkomen groeien de balken vanaf de as (styles.css). Alleen
      // dan: bij elke filterklik opnieuw zou het een trucje worden.
      statsView.classList.add("enter");
      setTimeout(() => statsView.classList.remove("enter"), 900);
      window.FollowUpStats.render(state.db, statsView, scheduleSave, pickedRegions());
    } else window.FollowUpStats.hideTip();
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
        if (b.dataset.ag === "ics") return downloadIcs(h, p);
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
      } else if (b.dataset.ag === "subscribe") {
        return feedDialog();
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
      setChosen(d.filter, toggle(chosen(d.filter), d.value));
      if (d.filter === "regions") redrawAfterRegion(agendaView);
      else renderFilters();
      renderList();
      renderMarkers();
      renderKpis();
      // Andere producten, andere soorten: alleen dat ene veld, de rest van de
      // filterrij blijft staan zodat de open uitklapper niet dichtklapt.
      const types = d.filter === "products" && $("[data-log-types]", agendaView);
      if (types) types.innerHTML = logTypesPick();
    } else if (d.logPick) {
      state.log[d.logPick] = toggle(state.log[d.logPick], d.value);
    } else if ("logPeriod" in d) {
      state.log.period = el.value;
    } else if ("agWho" in d) {
      // De hele agenda hertekent, dus onthouden we dat de uitklapper openstond:
      // anders klapt hij dicht bij elk vinkje.
      state.agenda = { ...state.agenda, assignees: toggle(state.agenda.assignees, d.value), day: "", whoOpen: true };
      renderAgenda();
      // De hele agenda is hertekend, dus het vakje waar je stond is een nieuw
      // vakje. Zonder dit staat de focus weer bovenaan de pagina.
      const again = [...agendaView.querySelectorAll("[data-ag-who]")].find((x) => x.dataset.value === d.value);
      if (again) again.focus();
      return;
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

  // Herladen brengt je terug waar je was: hetzelfde scherm, dezelfde fiche,
  // met de gegevens van nu. In sessionStorage en niet in localStorage: dat is
  // dit tabblad, dus wie de app opnieuw opent begint gewoon op de kaart. We
  // schrijven het op bij het weggaan in plaats van bij elke klik — één plaats,
  // en niets om bij te houden in de schermen zelf.
  const PLACE_KEY = "followup-place";
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(PLACE_KEY, JSON.stringify({
        view: document.body.dataset.view,
        hospital: state.ficheOpen ? state.selectedId : null,
        tab: state.agenda.tab,
        // Waar de kaart stond, zodat ze er meteen weer staat en niet eerst de
        // hele Benelux toont. Een verborgen kaart heeft geen zinnig midden.
        at: map.getContainer().offsetWidth ? [map.getCenter().lat, map.getCenter().lng, map.getZoom()] : null,
      }));
    } catch (e) { /* privévenster */ }
  });
  function readPlace() {
    try {
      const place = JSON.parse(sessionStorage.getItem(PLACE_KEY) || "null");
      return place && typeof place === "object" ? place : null;
    } catch (e) { return null; } // privévenster, of iets onleesbaars
  }
  // Meteen bij het laden, nog vóór de gegevens er zijn: het scherm waar je was
  // gaat al open, met streepjes waar de inhoud komt. Anders zag je eerst even
  // de kaart en sprong de app daarna pas naar je plek.
  // Wat we bij het laden hebben klaargezet. Zodra de gegevens er zijn maken we
  // het af, maar alleen als je er nog staat: wie tijdens het wachten naar een
  // ander scherm ging of de fiche sloot, wordt niet teruggetrokken.
  let early = null;
  $("#fiche").addEventListener("click", (e) => {
    if (!e.target.closest("[data-skel-close]")) return;
    const el = $("#fiche");
    el.hidden = true;
    el.innerHTML = "";
  });
  function showPlaceEarly() {
    const place = readPlace();
    if (!place) return;
    if (["planned", "log"].includes(place.tab)) state.agenda.tab = place.tab;
    // Het gebruikersscherm wacht: wie het mag zien weten we pas na aanmelden.
    if (["stats", "agenda"].includes(place.view)) setView(place.view);
    if (place.hospital) {
      const el = $("#fiche");
      el.innerHTML = skelFiche();
      el.hidden = false;
    }
    if (placeAt(place)) map.setView(place.at.slice(0, 2), place.at[2], { animate: false });
    early = { place, view: document.body.dataset.view };
  }
  // Drie getallen die ook echt een plek op de kaart zijn. sessionStorage is
  // van de hele site, niet alleen van deze app.
  const placeAt = (place) => !!place && Array.isArray(place.at) && place.at.length === 3 && place.at.every(Number.isFinite)
    && Math.abs(place.at[0]) <= 90 && Math.abs(place.at[1]) <= 180 && place.at[2] >= 0 && place.at[2] <= 19;
  // Zodra de gegevens er zijn, in twee stappen rond renderAll(): eerst welk
  // ziekenhuis openstond, zodat de fiche in één keer de echte wordt, en erna
  // de kaart en het scherm.
  function restoreSelection(place) {
    const h = place && place.hospital && byId(place.hospital);
    if (!h) return null;
    state.selectedId = h.id;
    state.ficheOpen = true;
    return h;
  }
  function restoreView(place, h) {
    if (!place) return;
    // De kaart staat al waar ze stond. Kennen we die plek niet (ze was
    // verborgen bij het herladen), dan naar het ziekenhuis, zonder vlucht.
    if (placeAt(place)) map.setView(place.at.slice(0, 2), place.at[2], { animate: false });
    else if (h && h.lat != null) {
      if (map.getContainer().offsetWidth) map.setView([h.lat, h.lng], Math.max(map.getZoom(), 13), { animate: false });
      else state.pendingFocus = [h.lat, h.lng];
    }
    const views = ["map", "list", "stats", "agenda", ...(store.can.manageUsers ? ["users"] : [])];
    if (views.includes(place.view)) setView(place.view);
  }
  showPlaceEarly();

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
        : `<p class="muted">${esc(t("users.none"))}</p>`}
      ${store.feeds ? `<div class="u-feeds">
        <h3>${esc(t("feeds.allTitle"))}</h3>
        <p class="muted">${esc(t("feeds.allIntro"))}</p>
        <div class="feed-list-all"><p class="muted">${esc(t("feeds.loading"))}</p></div>
      </div>` : ""}`;
    loadAllFeeds();
  }

  // Elk abonnement van iedereen, voor een beheerder: wie welk adres heeft en
  // of een agenda het nog ophaalt. Stopzetten maakt het adres meteen
  // ongeldig; het abonnement zelf zien of overnemen kan niet, het geheim
  // staat nergens.
  function loadAllFeeds() {
    const box = usersView.querySelector(".feed-list-all");
    if (!box) return;
    store.feedList(true).then((feeds) => {
      box.innerHTML = feeds.length ? `<ul class="feed-rows">${feeds.map((f) => feedRow(f, f.owner_name || "?",
        `<button type="button" class="btn small danger" data-feed-remove="${esc(f.id)}">${esc(t("feeds.remove"))}</button>`)).join("")}</ul>`
        : `<p class="muted">${esc(t("feeds.noneAll"))}</p>`;
    }, (e) => { box.innerHTML = `<p class="login-error">${esc(t("feeds.failed", { msg: e.message }))}</p>`; });
  }
  usersView.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-feed-remove]");
    if (!b || !(await ask(t("feeds.confirmRemoveOther"), { ok: t("feeds.remove") }))) return;
    try {
      await store.feedRemove(b.dataset.feedRemove);
      toast(t("feeds.removed"));
    } catch (err) {
      tell(t("feeds.failed", { msg: err.message }));
    }
    loadAllFeeds();
  });

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
      tell(t("users.failed", { msg: err.message }));
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
      showBanner(t("users.reloadNeeded"), true, "info");
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
    if (open === (!menuList.hidden && !leaving(menuList))) return; // elke klik op de pagina komt hier langs
    $("#menuBtn").setAttribute("aria-expanded", String(open));
    if (open) { stay(menuList); menuList.hidden = false; }
    else leave(menuList, () => { menuList.hidden = true; }, { ms: 90, shift: "translateY(-4px) scale(0.98)" });
  }
  $("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(menuList.hidden || leaving(menuList)); });
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
