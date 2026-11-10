/* FollowUp Prion – vaste waarden en één esc().
 *
 * Zowel app.js als stats.js hebben deze lijsten nodig. Ze staan hier op één
 * plaats, zodat een nieuwe verkoopfase of een nieuw scope-merk niet in twee
 * bestanden moet worden bijgehouden — en niet in één van de twee vergeten.
 *
 * In de databank staat telkens de sleutel, nooit de vertaalde tekst. De merken
 * zijn eigennamen en dus in beide talen gelijk; "other" is wél een sleutel en
 * wordt getoond via t("scope.other").
 */
window.FollowUpDomain = (() => {
  "use strict";

  // Verhoog dit nummer pas als de vorm van de data verandert; normalize() in
  // app.js moet dan oudere documenten kunnen bijwerken.
  const DB_VERSION = 1;

  const STATUSES = ["green", "orange", "red"];
  // In de databank staat de sleutel, niet de vertaalde tekst.
  const STAGES = [
    "prospect", "first_contact", "meeting", "demo_planned", "demo_installed",
    "evaluation", "purchasing", "customer", "on_hold", "not_interested",
  ];
  // Fases vóór de verkoop: een installatie of bestelling maakt er "customer" van.
  const PRE_SALE = ["prospect", "first_contact", "meeting", "demo_planned", "demo_installed", "evaluation", "purchasing"];
  const ACT_TYPES = {
    prospecting: "#7b61ff",
    email: "#3a8dde",
    call: "#0f5b8f",
    visit: "#16a3a3",
    congress: "#8a5cf6",
    demo: "#f29a1f",
    installation: "#22a45d",
    training: "#0ea5a5",
    quote: "#b45309",
    order: "#147a43",
    cancellation: "#c0433a",
    other: "#8a94a3",
  };
  // Contactmomenten waarbij een aantal kamers zinvol is. "cancellation" hoort
  // er ook bij: EndoQ en Ainex gaan per abonnement, en een stopgezet abonnement
  // haalt kamers weg — zie syncRooms() in app.js.
  const ROOM_TYPES = ["demo", "installation", "order", "cancellation"];
  // De producten die Prion verdeelt. Dit is de énige lijst: de filters, de
  // dialogen, het beheerscherm en de statistieken lezen hem allemaal hier, en
  // alles wat per product bestaat (kleur, doelcijfer) wordt eruit afgeleid.
  // Komt er een derde bij, dan volstaat deze regel — plus followup.producten()
  // in supabase/schema.sql, want de databank kan dit bestand niet lezen.
  const PRODUCTS = ["EndoQ", "Ainex", "Thyroid RFA", "Fibroid RFA"];
  // Niet elk product wordt op dezelfde manier verkocht. EndoQ en Ainex gaan
  // per abonnement, per kamer: daar tel je kamers en actieve abonnementen. De
  // RFA-producten worden per ingreep verbruikt — er is geen installatie en
  // geen abonnement, er worden elektroden besteld. Wat hier niet in staat is
  // een abonnement: zo gedraagt een product dat de app nog niet kent zich
  // zoals alles zich tot nu toe gedroeg.
  // De lijst hierboven blijft een lijst van namen, en dat is met opzet: die
  // naam is wat er in de databank staat, bij elk contactmoment en in elk
  // bereik. Wat een product ís, hangt er hier naast.
  const PRODUCT_KINDS = { "Thyroid RFA": "procedure", "Fibroid RFA": "procedure" };
  const productKind = (p) => PRODUCT_KINDS[p] || "subscription";
  // Bij welk contactmoment hoort een aantal? Een contactmoment draagt één
  // getal, en wat het telt hangt af van het product: kamers bij een product
  // per abonnement (demo, installatie, bestelling, stopzetting), bestelde
  // stuks bij een product per ingreep — en dan alleen bij een bestelling,
  // want een demo of een installatie in kamers bestaat daar niet. Dat blijft
  // een verkoopcijfer per ziekenhuis: wat er besteld is, nooit wie er
  // behandeld is.
  const wantsQuantity = (type, product) =>
    (productKind(product) === "procedure" ? type === "order" : ROOM_TYPES.includes(type));
  // Welke producten deze gebruiker mag gebruiken. Een leeg bereik betekent
  // onbeperkt, dus dan zijn het ze allemaal. De databank schermt het document
  // al af; dit is er zodat de app geen keuze aanbiedt die toch geweigerd wordt.
  // Staat hier en niet in app.js, omdat stats.js hem evengoed nodig heeft.
  // window.FollowUpStore wordt pas later geladen, dus we lezen hem bij elke
  // oproep opnieuw in plaats van één keer bij het starten.
  const myProducts = () => {
    const can = window.FollowUpStore && window.FollowUpStore.can;
    return can && can.products && can.products.length ? can.products : PRODUCTS;
  };
  // De kleur van een product in de grafieken, op volgorde van de lijst
  // hierboven. styles.css heeft --series-1 tot en met --series-6; een zevende
  // product valt terug op de grijze kleur van "geen product" in plaats van
  // onzichtbaar te worden.
  const productColor = (p) => {
    const i = PRODUCTS.indexOf(p);
    return i >= 0 && i < 6 ? `var(--series-${i + 1})` : "var(--series-none)";
  };
  // Een doelcijferrij met elk product op nul.
  const emptyTargets = () => Object.fromEntries(PRODUCTS.map((p) => [p, 0]));
  // Eén lijst van fases voor alle producten — zo blijven de pijplijn en de
  // filters in één taal spreken — maar niet elk product doorloopt ze
  // allemaal. Een RFA-product wordt niet geïnstalleerd, en moet wél langs het
  // Comité Medisch Materiaal voor het besteld mag worden: vandaar "purchasing"
  // daar, en "demo_installed" hier. Blijkt EndoQ of Ainex die stap ook te
  // hebben, dan volstaat het de filter hieronder weg te halen.
  const stagesFor = (p) => STAGES.filter((s) => s !== (productKind(p) === "procedure" ? "demo_installed" : "purchasing"));
  // De opvolging staat per product in h.pipeline: { fase, kleur, wie }. Wat er
  // op het ziekenhuis zelf staat (h.status, h.stage) is daarvan afgeleid: het
  // product dat het verst staat. "Verst" is eerst de kleur, dan de fase; on
  // hold en niet geïnteresseerd staan achter prospect, zodat een afgehaakt
  // product een lopend dossier nooit verbergt.
  const STATUS_RANK = { green: 2, orange: 1, red: 0 };
  const stageRank = (st) => (st === "on_hold" || st === "not_interested" ? -1 : STAGES.indexOf(st));
  const furthest = (entries) => entries.reduce((best, e) =>
    ((STATUS_RANK[e.status] - STATUS_RANK[best.status]) || (stageRank(e.stage) - stageRank(best.stage))) > 0 ? e : best);
  // Wat je van een ziekenhuis toont, gegeven de producten waarop gefilterd is.
  // Geen filter: het geheel, zoals het op het ziekenhuis staat. Wel een filter:
  // het verste van díe producten — en is er voor geen van die producten iets,
  // dan is het ziekenhuis daarvoor gewoon nog een prospect.
  const pipelineView = (h, products) => {
    if (!products || !products.length) return h;
    const entries = products.filter((p) => h.products.includes(p) && h.pipeline && h.pipeline[p]).map((p) => h.pipeline[p]);
    return entries.length ? furthest(entries) : { status: "red", stage: "prospect", owner: "" };
  };
  // Wat je van een ziekenhuis moet weten voor een product per ingreep — de
  // tegenhanger van de endoscopie-afdeling bij EndoQ en Ainex. CMM is het
  // Comité Medisch Materiaal: zolang dat het product niet goedgekeurd heeft,
  // mag het ziekenhuis niet bestellen. Sleutels, zoals overal: de tekst komt
  // uit i18n.js.
  const CMM_STATES = ["not_ok", "requested", "ok"];
  const YES_NO = ["yes", "no", "unknown"];
  const SCOPE_BRANDS = ["Olympus", "Pentax", "Fujifilm", "other"];
  // De toren staat los van de scopes — daar hangt EndoQ of
  // Ainex aan, dus
  // daar valt of staat de aansluiting mee. Bij deze drie komt hij van
  // dezelfde fabrikant, vandaar dezelfde lijst; loopt dat ooit uiteen, dan
  // splits je ze hier.
  const PROCESSOR_BRANDS = SCOPE_BRANDS;
  // Diensten waar een contactpersoon toe behoort. Niet alleen de artsen
  // beslissen mee: ICT, aankoop en de biomedische dienst evengoed.
  // De volgorde is die van de keuzelijst: eerst de artsen per discipline, dan
  // de diensten eromheen. "physician" is de gastro-enteroloog — de sleutel is
  // ouder dan de RFA-producten en blijft zo heten, anders verliezen bestaande
  // contactpersonen hun dienst.
  const DEPARTMENTS = [
    "physician", "endoscopy", "radiology", "endocrinology", "nuclear", "ent", "surgery", "gynaecology",
    "pharmacy", "it", "purchasing", "biomed", "admin", "secretariat", "other",
  ];
  const SECTORS = ["public", "private", "university"];
  // De taal waarin je een contactpersoon aanspreekt. Codes, geen vertaalde
  // namen: ze zijn in beide talen van de app gelijk.
  const LANGUAGES = ["NL", "FR", "DE", "EN"];
  const COUNTRIES = ["BE", "NL", "LU"];
  // Rollen, van veel naar weinig rechten. In de databank staat de sleutel; wat
  // elke rol precies mag staat in storage.js (RIGHTS) en wordt afgedwongen in
  // supabase/schema.sql.
  const ROLES = ["admin", "editor", "contributor", "viewer"];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // De uitklapper met vinkjes. Staat hier omdat vijf schermen hem gebruiken:
  // de drie filters in de zijbalk, de producten van een contactpersoon, het
  // product van een contactmoment en van een gepland moment, het bereik van
  // een gebruiker, en de filter op de statistiekpagina. Een <select multiple>
  // kan dit ook, maar die is op een telefoon niet te bedienen en toont niet
  // wat er aanstaat zonder open te klappen.
  //
  // Hij krijgt de rijen als gegevens en niet als opmaak, en daar hangt de rest
  // aan: zo weet hij zelf wat er aanstaat en hoe elke rij heet, en houdt hij
  // zijn eigen samenvatting bij — bij het opbouwen en bij elk vinkje. Eerst
  // deed elk scherm dat apart, vijf keer, elk met een eigen data-veld erbij.
  //
  // Per rij: attrs, label, checked, en eventueel cls of type. In attrs hangt
  // het scherm de data-velden waarmee het zijn eigen keuze weer opvangt; die
  // gaan ongefilterd de tag in — dat moet wel, het zijn attributen en geen
  // tekst — dus elke oproeper zet er zelf esc() rond, net als bij elke andere
  // sjabloon in dit project. Alleen vaste namen en al ontsmette waarden dus.
  //
  // type "radio" maakt er een keuze van één. Die vorm gebruiken de dialogen
  // van een contactmoment en een gepland moment: zo'n moment hoort bij één
  // product. Dat is geen vergetelheid — de kamers van een installatie tellen
  // mee voor het doelcijfer van dat product, en "drie kamers voor allebei" is
  // geen getal dat ergens eerlijk op te tellen valt.
  const pickRow = (r) =>
    `<label class="${esc(r.cls || "")}"><input type="${esc(r.type || "checkbox")}" ${r.attrs} ${r.checked ? "checked" : ""}>${esc(r.label)}</label>`;
  // leeg is de tekst voor "niets aangevinkt". Zit er een rij "alle" in de
  // lijst, dan komt het nooit zover: dan staat díe aan en is zíj de tekst.
  //
  // De samenvatting staat in een eigen span en niet los in de summary. Twee
  // redenen: het pijltje ernaast is een flex-item en blijft zo op dezelfde
  // regel staan, en wie de tekst bijwerkt met textContent zou dat pijltje
  // anders mee overschrijven.
  // De regel zelf, op één plaats: de namen van wat aanstaat achter elkaar, en
  // anders de lege tekst. Hij wordt twee keer toegepast — bij het opbouwen op
  // de rijen, en daarna op de pagina — en moet dus ook maar één keer bestaan.
  const pickSamenvatting = (namen, leeg) => (namen.length ? namen.join(", ") : leeg);
  const pickBox = (rows, leeg, open) =>
    `<details class="pick" data-pick-empty="${esc(leeg)}" ${open ? "open" : ""}><summary><span class="pick-label">${
      esc(pickSamenvatting(rows.filter((r) => r.checked).map((r) => r.label), leeg))}</span></summary>
       <div class="pick-list">${rows.map(pickRow).join("")}</div></details>`;
  // Dezelfde samenvatting, nu uit de pagina gelezen in plaats van uit de
  // gegevens: elke rij draagt zijn eigen tekst al, dus de teksten van de
  // aangevinkte vakjes achter elkaar geven precies hetzelfde antwoord.
  const syncPick = (box) => {
    const sum = box.querySelector(".pick-label");
    if (!sum) return;
    sum.textContent = pickSamenvatting(
      [...box.querySelectorAll(".pick-list input:checked")]
        .map((i) => (i.closest("label") || { textContent: "" }).textContent.trim())
        .filter(Boolean),
      box.dataset.pickEmpty || "");
  };
  // <details> gaat uit zichzelf nooit dicht: je moest er twee keer op klikken.
  // Eén luisteraar op het document doet dat voor alle uitklappers samen, ook
  // die in een dialoog en die er bij een volgende render bijkomen. Een klik ín
  // de uitklapper telt niet mee — anders sloeg het vakje dat je net aanvinkte
  // de uitklapper meteen weer dicht.
  const sluitPicks = (behalve) => {
    for (const d of document.querySelectorAll("details.pick[open]")) {
      if (d !== behalve && !d.contains(behalve)) d.open = false;
    }
  };
  // De twee luisteraars hieronder zijn het enige in dit bestand dat de pagina
  // aanraakt; al de rest is rekenwerk op vaste waarden. Vandaar de vraag of er
  // wel een document is: zonder haar is domain.js buiten een browser niet meer
  // in te lezen, en dat is net waar "Known and accepted" in CLAUDE.md op
  // rekent — komen er ooit controles, dan zijn het node-assertions over de
  // zuivere functies die hier staan.
  if (typeof document !== "undefined") {
    // In de capture-fase, dus vóórdat de pagina op die klik reageert. De
    // statistiekpagina tekent zichzelf opnieuw zodra je een vinkje zet; liep
    // dit daarna, dan was het aangeklikte vakje al uit het document verdwenen
    // en sloot de verse uitklapper zich alsnog.
    document.addEventListener("click", (e) => sluitPicks(e.target), true);
    // En hier houdt het component zijn eigen samenvatting bij. Eén luisteraar
    // voor alle uitklappers samen, ook die in een dialoog en die er bij een
    // volgende render bijkomen. Een scherm dat de vinkjes zelf verzet, roept
    // syncPick() er zelf bij — die luisteraar ziet zoiets niet, want een
    // vinkje dat JavaScript aanzet stuurt geen change.
    document.addEventListener("change", (e) => {
      const box = e.target.closest && e.target.closest("details.pick");
      if (box) syncPick(box);
    });
    // Escape sluit eerst de uitklapper en pas daarna de dialoog eronder. Zonder
    // preventDefault zou één toets allebei doen en ben je je dialoog kwijt.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !document.querySelector("details.pick[open]")) return;
      sluitPicks(null);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  return {
    DB_VERSION, STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS: Object.keys(ACT_TYPES),
    ROOM_TYPES, PRODUCTS, CMM_STATES, YES_NO, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, LANGUAGES, COUNTRIES, ROLES,
    esc, pickBox, syncPick, myProducts, productColor, productKind, wantsQuantity, stagesFor, furthest, pipelineView, emptyTargets,
  };
})();
