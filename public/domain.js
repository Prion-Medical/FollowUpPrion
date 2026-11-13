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
    procedure: "#d9467a",
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
  // Contactmomenten waarbij stuks verkocht zijn, bij een product per ingreep:
  // wat besteld is, en wat verbruikt is tijdens een procedure waar een van ons
  // bij stond. Dat laatste wordt evengoed betaald en telt dus mee.
  const SOLD_TYPES = ["order", "procedure"];
  // De producten die Prion verdeelt. Dit is de énige lijst: de filters, de
  // dialogen, het beheerscherm en de statistieken lezen hem allemaal hier, en
  // alles wat per product bestaat (kleur, doelcijfer) wordt eruit afgeleid.
  // Komt er een derde bij, dan volstaat deze regel — plus followup.producten()
  // in supabase/schema.sql, want de databank kan dit bestand niet lezen.
  const PRODUCTS = ["EndoQ", "Ainex", "Thyroid RFA", "Fibroid RFA", "Stents"];
  // Niet elk product wordt op dezelfde manier verkocht. EndoQ en Ainex gaan
  // per abonnement, per kamer: daar tel je kamers en actieve abonnementen. De
  // RFA-producten worden per ingreep verbruikt — er is geen installatie en
  // geen abonnement, er worden elektroden besteld. Stents idem: één
  // product voor alle stents samen, niet één per model. Wat hier niet in staat is
  // een abonnement: zo gedraagt een product dat de app nog niet kent zich
  // zoals alles zich tot nu toe gedroeg.
  // De lijst hierboven blijft een lijst van namen, en dat is met opzet: die
  // naam is wat er in de databank staat, bij elk contactmoment en in elk
  // bereik. Wat een product ís, hangt er hier naast.
  const PRODUCT_KINDS = { "Thyroid RFA": "procedure", "Fibroid RFA": "procedure", Stents: "procedure" };
  const productKind = (p) => PRODUCT_KINDS[p] || "subscription";
  // Bij welk contactmoment hoort een aantal? Een contactmoment draagt één
  // getal, en wat het telt hangt af van het product: kamers bij een product
  // per abonnement (demo, installatie, bestelling, stopzetting), bestelde
  // stuks bij een product per ingreep — en dan alleen bij een bestelling of
  // een procedure (verbruikte stuks), want een demo of een installatie in
  // kamers bestaat daar niet. Dat blijft een verkoopcijfer per ziekenhuis:
  // wat er besteld of verbruikt is, nooit wie er behandeld is.
  const wantsQuantity = (type, product) =>
    (productKind(product) === "procedure" ? SOLD_TYPES.includes(type) : ROOM_TYPES.includes(type));
  // Welke soorten contactmoment je bij een product kunt kiezen. De lijst
  // versmalt alleen de keuze: een bewaard moment met een soort die hier niet
  // meer in staat, blijft bestaan en blijft leesbaar. "prospecting" is zo'n
  // soort: het zei dat het een eerste benadering was maar niet hoe, en mail,
  // telefoon en bezoek hebben elk hun eigen soort. Een product per ingreep
  // wordt niet geïnstalleerd en niet stopgezet; bij een abonnement is een
  // demo wat daar een procedure is.
  const RETIRED_TYPES = ["prospecting"];
  const typesFor = (p) => Object.keys(ACT_TYPES).filter((k) => !RETIRED_TYPES.includes(k)
    && !(productKind(p) === "procedure" ? ["installation", "cancellation"] : ["procedure"]).includes(k));
  // Voor meerdere producten samen (het bereik van een account, de filter van
  // het logboek): alles wat bij minstens één ervan hoort, in de vaste volgorde.
  const typesOffered = (products) => Object.keys(ACT_TYPES).filter((k) => products.some((p) => typesFor(p).includes(k)));
  // Soorten binnen één product, waar die bestaan. Bij stents verschilt te veel
  // per soort om ze op één hoop te tellen; een bestelling of een procedure
  // kan er daarom één meekrijgen, en de statistieken tellen per soort.
  // Sleutels, zoals overal: de tekst komt uit i18n.js ("family.x").
  const FAMILIES = { Stents: ["oesophageal", "biliary", "colonic", "other"] };
  const familiesFor = (p) => (Object.prototype.hasOwnProperty.call(FAMILIES, p) ? FAMILIES[p] : []);
  // Bij een moment met een aantal hoort ook de soort, als het product er kent:
  // een bestelling of een procedure dus. Ook een gepland moment van die soort
  // kan haar al dragen; bij het afvinken gaat ze mee.
  const wantsFamily = (type, product) => familiesFor(product).length > 0 && wantsQuantity(type, product);
  // Een moment gaat meestal over één product, soms over meer: een gesprek
  // over Thyroid RFA en Fibroid RFA tegelijk. Twee vormen dus, zoals de
  // databank ze ook leest (in_scope): "product" met één naam, of "products"
  // met een lijst. Bestaande momenten houden de eerste vorm; de lijst komt er
  // pas als iemand er meer dan één kiest, en blijft dan de vorm van dat
  // record, ook als er later maar één overblijft. Terugzetten kan niet
  // veilig: wie afgeschermd is ziet maar een deel van de lijst, en de
  // databank voegt de rest er alleen bij zolang het een lijst is.
  const productsOf = (r) => (!r ? [] : Array.isArray(r.products) ? r.products : r.product ? [r.product] : []);
  // Hét product van een moment: de naam als het er precies één is, anders
  // leeg. Alles wat een aantal telt (kamers, stuks) hoort bij één product.
  const productOf = (r) => { const l = productsOf(r); return l.length === 1 ? l[0] : ""; };
  // De soorten die bij een keuze van producten passen. Geen product: alles
  // wat het account kan kiezen. Eén: de soorten van dat product. Meer: wat
  // bij elk ervan bestaat en bij geen ervan een aantal draagt, want een
  // aantal is niet over twee producten te verdelen.
  //
  // gedeeld: het moment staat in de lijstvorm (shared() hieronder). Wie
  // maar één product mag, ziet van een gesprek over twee producten enkel het
  // zijne; het is toch een moment over meer, en draagt dus geen aantal.
  const typesAmong = (list, mine, gedeeld = false) => (!list.length ? typesOffered(mine)
    : list.length === 1 && !gedeeld ? typesFor(list[0])
    : Object.keys(ACT_TYPES).filter((k) => list.every((p) => typesFor(p).includes(k) && !wantsQuantity(k, p))));
  // Staat een moment in de lijstvorm, dan gaat het over meer dan één product,
  // ook als wie het bekijkt er maar één van ziet (de databank snoeit de
  // lijst). Zo'n moment draagt nooit een aantal of een soort stent; de
  // databank haalt ze er ook zelf af (zonder_aantal() in schema.sql).
  const shared = (r) => !!r && Array.isArray(r.products);
  // De soorten die elk van de gekozen producten kent, ook die met een aantal.
  // Voor een plan (dat draagt nooit een aantal) en voor een nieuw contactmoment
  // over meer producten met een aantal: dat wordt bij het bewaren één
  // contactmoment per product, elk met zijn eigen aantal.
  const typesInAll = (list, mine) => (!list.length ? typesOffered(mine)
    : Object.keys(ACT_TYPES).filter((k) => list.every((p) => typesFor(p).includes(k))));
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
  // Niet elk product per ingreep wil dezelfde gegevens. Bij stents verschilt
  // de CMM-goedkeuring per soort stent, zodat één veld per ziekenhuis niets
  // zou zeggen, en "doet al" en de huidige leverancier worden daar niet
  // bijgehouden, een prioriteit evenmin: alleen een notitie blijft over.
  const FACTS = ["cmm", "prio", "doesAlready", "currentSystem", "notes"];
  const PRODUCT_FACTS = { Stents: ["notes"] };
  const factsFor = (p) => (productKind(p) !== "procedure" ? []
    : Object.prototype.hasOwnProperty.call(PRODUCT_FACTS, p) ? PRODUCT_FACTS[p] : FACTS);
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
  // Regio's: welke landen samen een werkgebied vormen, en welk stuk kaart
  // daarbij hoort ([[zuid, west], [noord, oost]]). Een ziekenhuis draagt zelf
  // geen regio: ze volgt uit zijn land (regionOf), zodat de twee elkaar nooit
  // kunnen tegenspreken en bestaande data niets hoeft bij te krijgen. Een
  // regio toevoegen is hier één regel, plus de namen in i18n.js ("region.x"
  // en "country.XX"). Zolang er maar één is, toont de app geen regiofilter.
  const REGIONS = {
    benelux: { countries: ["BE", "NL", "LU"], bounds: [[49.3, 2.3], [53.7, 7.4]] },
    australia: { countries: ["AU"], bounds: [[-44, 112], [-10, 154]] },
  };
  const REGION_KEYS = Object.keys(REGIONS);
  const COUNTRIES = REGION_KEYS.flatMap((r) => REGIONS[r].countries);
  const regionOf = (country) => REGION_KEYS.find((r) => REGIONS[r].countries.includes(country)) || "";
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
  // type "radio" maakt er een keuze van één. Die vorm gebruikten de dialogen
  // van een contactmoment en een gepland moment, tot een gesprek over twee
  // producten tegelijk moest kunnen. Wat een aantal draagt hoort nog altijd
  // bij één product (typesAmong): "drie kamers voor allebei" is geen getal
  // dat ergens eerlijk op te tellen valt.
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
  // voor is wat er vóór de namen komt te staan, voor een uitklapper waarvan de
  // keuzes zelf niet zeggen waar ze over gaan: "Toegewezen aan: Anna" leest
  // als een filter, "Anna" alleen niet. De lege tekst zegt het al zelf.
  const pickSamenvatting = (namen, leeg, voor) => (namen.length ? (voor ? voor + ": " : "") + namen.join(", ") : leeg);
  const pickBox = (rows, leeg, open, voor) =>
    // De samenvatting ook als title: op een smalle knop wordt ze afgekapt, en
    // dan is dit de enige plek waar ze nog helemaal staat.
    ((tekst) => `<details class="pick" data-pick-empty="${esc(leeg)}" data-pick-prefix="${esc(voor || "")}" ${open ? "open" : ""}><summary><span class="pick-label" title="${esc(tekst)}">${
      esc(tekst)}</span></summary>
       <div class="pick-list">${rows.map(pickRow).join("")}</div></details>`)(pickSamenvatting(rows.filter((r) => r.checked).map((r) => r.label), leeg, voor));
  // Dezelfde samenvatting, nu uit de pagina gelezen in plaats van uit de
  // gegevens: elke rij draagt zijn eigen tekst al, dus de teksten van de
  // aangevinkte vakjes achter elkaar geven precies hetzelfde antwoord.
  const syncPick = (box) => {
    const sum = box.querySelector(".pick-label");
    if (!sum) return;
    sum.title = sum.textContent = pickSamenvatting(
      [...box.querySelectorAll(".pick-list input:checked")]
        .map((i) => (i.closest("label") || { textContent: "" }).textContent.trim())
        .filter(Boolean),
      box.dataset.pickEmpty || "", box.dataset.pickPrefix || "");
  };
  // <details> gaat uit zichzelf nooit dicht: je moest er twee keer op klikken.
  // Eén luisteraar op het document doet dat voor alle uitklappers samen, ook
  // die in een dialoog en die er bij een volgende render bijkomen. Een klik ín
  // de uitklapper telt niet mee — anders sloeg het vakje dat je net aanvinkte
  // de uitklapper meteen weer dicht.
  // Dichtklappen gaat zacht, via leave() in ui.js; dat bestand wordt na dit
  // geladen, maar hier komen we pas bij een klik. Is het er niet (buiten een
  // browser), dan klapt de lijst gewoon dicht.
  const sluitPick = (d) => {
    const ui = window.FollowUpUI, list = d.querySelector(".pick-list");
    if (ui && list) ui.leave(list, () => { d.open = false; }, { ms: 90 });
    else d.open = false;
  };
  const sluitPicks = (behalve) => {
    for (const d of document.querySelectorAll("details.pick[open]")) {
      if (d !== behalve && !d.contains(behalve)) sluitPick(d);
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
    document.addEventListener("click", (e) => {
      sluitPicks(e.target);
      // Een klik op de eigen knop van een open uitklapper: de browser zou hem
      // in één klap sluiten. Dat doen we zelf, even zacht als de andere.
      const knop = e.target.closest && e.target.closest("details.pick[open] > summary");
      if (knop) { e.preventDefault(); sluitPick(knop.parentElement); }
    }, true);
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

  // ---------- twee mensen tegelijk ----------
  // Het document is één geheel en de databank weigert een opslag zodra iemand
  // anders ondertussen iets bewaarde, wat het ook was. Hiermee hoeft dat geen
  // "herlaad en doe het opnieuw" meer te zijn: we leggen drie versies naast
  // elkaar — basis (wat we laatst van de databank kenden), mine (wat hier nu
  // staat) en theirs (wat de databank nu heeft) — en nemen van elk stuk de
  // kant die veranderd is. Pas als allebei hetzelfde stuk anders veranderden
  // is er echt een conflict, en dat komt in de lijst terecht.
  //
  // Zuiver rekenwerk op gewone JSON, zodat het zonder browser na te kijken is.
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const deepEqual = (a, b) => {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    if (!isObj(a) || !isObj(b)) return false;
    // De volgorde van de sleutels telt niet: de app en de databank bouwen
    // hetzelfde object niet altijd in dezelfde volgorde op.
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  };
  // Een lijst van records met een id (ziekenhuizen, contactpersonen,
  // contactmomenten, geplande momenten) of een lijst van losse waarden
  // (producten, merken). Een lege lijst past bij allebei.
  const isRecords = (v) => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string" && x.id);
  const isValues = (v) => Array.isArray(v) && v.every((x) => !isObj(x) && !Array.isArray(x));
  // De stempel zet de databank zelf, op wie bewaart: daarover valt niet te
  // twisten. nextAction volgt altijd uit planned[], en normalize() rekent het
  // na het samenvoegen opnieuw uit.
  const STAMP_KEYS = ["createdBy", "createdAt", "updatedBy", "updatedAt"];
  const DERIVED_KEYS = ["nextAction", "nextActionDate"];
  const isHospital = (path) => path.length === 2 && path[0] === "hospitals";
  const settled = (path) => STAMP_KEYS.includes(path[path.length - 1])
    || (path.length === 3 && path[0] === "hospitals" && DERIVED_KEYS.includes(path[2]));
  // Een record zonder zijn stempel. De app zet de stempel zelf en de databank
  // zet hem opnieuw, en die twee zijn niet altijd letterlijk gelijk (de dag
  // van de browser tegenover die van Brussel). Wie daarop vergelijkt, ziet
  // een wijziging van de collega waar er geen is.
  const bare = (r) => {
    if (!isObj(r)) return r;
    const o = {};
    for (const k of Object.keys(r)) if (!STAMP_KEYS.includes(k)) o[k] = r[k];
    return o;
  };
  const untouched = (now, before) => deepEqual(bare(now), bare(before));
  // Kamers die een contactmoment bijtelt of aftrekt: dezelfde regel als
  // syncRooms() in app.js, hier nodig om te zien of een gewijzigd aantal
  // geïnstalleerde kamers uit contactmomenten volgt of met de hand is getypt.
  const roomsFrom = (h) => ((h && h.activities) || []).reduce((n, a) => {
    if (!a || !a.rooms || productKind(productOf(a)) !== "subscription") return n;
    return n + (a.type === "installation" ? a.rooms : a.type === "cancellation" ? -a.rooms : 0);
  }, 0);
  // Wat alleen op het niveau van één ziekenhuis te beslissen valt.
  function settleHospital(base, mine, theirs, out, conflicts, path) {
    const drop = (key) => {
      const i = conflicts.findIndex((c) => c.length === path.length + key.length && key.every((k, n) => c[path.length + n] === k));
      if (i >= 0) conflicts.splice(i, 1);
    };
    // Geïnstalleerde kamers zijn een teller: een installatie telt erbij, en
    // twee mensen die er elk een invoeren moeten bij de som uitkomen, niet bij
    // één van de twee. Volgt de wijziging aan elke kant precies uit de
    // contactmomenten van die kant, dan tellen we de twee verschillen op. Is
    // het getal met de hand gezet, dan blijft het wat het algemene
    // samenvoegen ervan maakte: gelijk is gelijk, anders een conflict.
    const n = (h) => Number(h && h.unit && h.unit.roomsInstalled) || 0;
    const dm = n(mine) - n(base), dt = n(theirs) - n(base);
    if (dm && dt && dm === roomsFrom(mine) - roomsFrom(base) && dt === roomsFrom(theirs) - roomsFrom(base) && isObj(out.unit)) {
      out.unit = { ...out.unit, roomsInstalled: Math.max(0, n(base) + dm + dt) };
      drop(["unit", "roomsInstalled"]);
    }
    // Eén hoofdcontact per product. Kozen twee mensen elk een ander voor
    // hetzelfde product, dan zouden er na het samenvoegen twee zijn; die regel
    // woont in de dialoog en niet in normalize(). Wie nu bewaart heeft het
    // laatste woord, en wat een collega voor een ander product koos blijft.
    if (Array.isArray(out.contacts) && out.contacts.filter((c) => c && c.primary).length > 1) {
      const kept = out.contacts.filter((c) => c && c.primary && (mine.contacts || []).some((m) => m && m.primary && m.id === c.id));
      out.contacts = out.contacts.map((c) => (c && c.primary && !kept.includes(c) && kept.some((k) => sameGround(k, c)) ? { ...c, primary: false } : c));
    }
  }
  // Hoofdcontact is er één per product: het sterretje van een contactpersoon
  // geldt voor de producten waar hij bij hoort. Twee contactpersonen staan
  // elkaar in de weg zodra ze een product delen, of zodra een van beide bij
  // geen enkel product hoort en dus voor het ziekenhuis als geheel geldt. Er
  // is bewust geen apart veld per product: wie bij twee producten hoort is
  // hoofdcontact voor allebei of voor geen van beide.
  const sameGround = (a, b) => {
    const pa = a.products || [], pb = b.products || [];
    return !pa.length || !pb.length || pa.some((p) => pb.includes(p));
  };
  const setMain = (h, c) => {
    for (const x of h.contacts) if (x !== c && x.primary && sameGround(x, c)) x.primary = false;
    c.primary = true;
  };
  // Het hoofdcontact voor een product; zonder product het eerste dat er is.
  const mainContact = (h, product) => {
    const mains = h.contacts.filter((c) => c.primary);
    if (!product) return mains[0];
    return mains.find((c) => (c.products || []).includes(product)) || mains.find((c) => !(c.products || []).length);
  };
  function merge3(base, mine, theirs, conflicts = [], path = []) {
    if (deepEqual(mine, theirs)) return mine;
    if (deepEqual(mine, base)) return theirs;
    if (deepEqual(theirs, base)) return mine;
    // Vanaf hier veranderden allebei, en niet naar hetzelfde.
    if (isRecords(mine) && isRecords(theirs) && (base == null || isRecords(base))) {
      const b = new Map((base || []).map((r) => [r.id, r]));
      const m = new Map(mine.map((r) => [r.id, r]));
      const out = [];
      // Hun volgorde, met wat alleen hier bestaat erachter.
      for (const r of theirs) {
        if (m.has(r.id)) out.push(merge3(b.get(r.id), m.get(r.id), r, conflicts, [...path, r.id]));
        else if (!b.has(r.id)) out.push(r); // door hen toegevoegd
        // Hier verwijderd. Bleef het bij hen zoals het was, dan is het weg;
        // werkten zij er net aan, dan mag het niet stil verdwijnen.
        else if (!untouched(r, b.get(r.id))) { conflicts.push([...path, r.id]); out.push(r); }
      }
      const seen = new Set(theirs.map((r) => r.id));
      for (const r of mine) {
        if (seen.has(r.id)) continue;
        if (!b.has(r.id)) out.push(r); // hier toegevoegd
        // Door hen verwijderd terwijl het hier veranderde.
        else if (!untouched(r, b.get(r.id))) { conflicts.push([...path, r.id]); out.push(r); }
      }
      return out;
    }
    if (isValues(mine) && isValues(theirs) && (base == null || isValues(base))) {
      // Vinkjes: wat zij hebben, plus wat hier bijkwam, min wat hier wegging.
      const b = base || [];
      const gone = b.filter((x) => !mine.includes(x));
      const added = mine.filter((x) => !b.includes(x));
      return [...theirs.filter((x) => !gone.includes(x)), ...added.filter((x) => !theirs.includes(x))];
    }
    if (isObj(mine) && isObj(theirs) && (base == null || isObj(base))) {
      const out = {};
      const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])];
      // products eerst: daar hangt van af of de kleur en de fase van het
      // ziekenhuis afgeleid zijn.
      if (isHospital(path)) keys.sort((a, b) => (b === "products") - (a === "products"));
      for (const k of keys) {
        // Een sleutel met deze naam vervangt het prototype in plaats van een
        // waarde te zetten. In echte gegevens komt hij niet voor.
        if (k === "__proto__") continue;
        // Met een product aangevinkt volgen kleur en fase uit de opvolging per
        // product en rekent normalize() ze opnieuw uit. Zonder product zijn ze
        // met de hand gezet, en dan is twee keer anders gewoon een conflict.
        if (isHospital(path) && (k === "status" || k === "stage") && (out.products || []).length) { out[k] = mine[k]; continue; }
        const v = merge3(base == null ? undefined : base[k], mine[k], theirs[k], conflicts, [...path, k]);
        if (v !== undefined) out[k] = v;
      }
      if (isHospital(path)) settleHospital(base, mine, theirs, out, conflicts, path);
      return out;
    }
    if (!settled(path)) conflicts.push(path);
    return mine;
  }

  // ---------- wat een contactmoment met de opvolging doet ----------
  // Hier en niet in app.js: de koppeling voor een assistent houdt er een kopie
  // van, en tests/regels.mjs legt de twee naast elkaar. Geen meldingen: wat
  // een kleur veranderde geven stageStatus() en autoStatus() terug, en de app
  // toont dat.
  const str = (v) => (v == null ? "" : String(v));
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

  // Verkoopfase bepaalt mee de kleur: Klant = groen, actieve fases = oranje.
  // x is waar de fase en de kleur staan: de opvolging van één product, of het
  // ziekenhuis zelf zolang er geen product aan hangt.
  function stageStatus(x, contacted) {
    const before = x.status;
    if (x.stage === "customer") x.status = "green";
    else if (x.stage === "prospect") x.status = contacted ? x.status : "red";
    else if (x.stage !== "not_interested" && x.status !== "green") x.status = "orange";
    // De nieuwe kleur als ze veranderde, anders niets: de app toont er een
    // melding bij, de koppeling en de controles niet.
    return x.status !== before ? x.status : null;
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
    // Welke kleur erbij kwam, voor de melding in de app: groen wint.
    let naar = null;
    for (const [x, p] of targets) {
      if ((act.type === "installation" || act.type === "order") && x.status !== "green") {
        x.status = "green";
        if (PRE_SALE.includes(x.stage)) x.stage = "customer";
        naar = "green";
      } else if (x.status === "red") {
        x.status = "orange";
        if (x.stage === "prospect") x.stage = "first_contact";
        if (naar !== "green") naar = "orange";
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
    return naar;
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

  // ---------- planning en tellen ----------
  // Ook hier omdat de koppeling (en voor de volgorde ook de databank) een
  // kopie houdt, en tests/ die kopieën naast deze legt.
  //
  // De volgorde van geplande momenten: op datum, en op dezelfde dag eerst wat
  // een uur heeft, in volgorde; wat "ergens die dag" is, komt na wat om negen
  // uur begint. Een moment zonder datum heeft een lege datum en komt dus
  // vooraan. Zo ligt h.planned opgeslagen, net als in fix_planned() in de
  // databank en sortPlanned() in de koppeling: nextAction is dan wat de
  // agenda als eerste toont.
  const byWhen = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.time || "99").localeCompare(b.time || "99");
  // Voor wie een gepland moment is. Zonder toewijzing is dat wie het invoerde:
  // wie iets plant, volgt het bijna altijd ook op, en zo werkt de filter in de
  // agenda meteen voor alles wat er al stond.
  const assigneeOf = (p) => p.assignee || p.createdBy || "";
  // Wat afgevinkt wordt, gebeurde ten laatste vandaag: een plan zonder datum
  // of voor volgende week staat dan op vandaag, tot iemand iets anders kiest.
  const tickOffDate = (plan, vandaag) => (plan.date && plan.date <= vandaag ? plan.date : vandaag);
  // Een installatie zonder aantal telt als één kamer; een stopzetting telt
  // negatief, zodat "actief" echt actief blijft.
  const rooms = (a) => Number(a.rooms) || 1;
  const signedRooms = (a) => (a.type === "cancellation" ? -rooms(a) : rooms(a));
  // Verkochte stuks: wat besteld is, en wat verbruikt is tijdens een
  // procedure. Zonder aantal telt een bestelling als één, maar een ingevulde
  // nul is nul: een gratis proefzending is geen verkoop. Een procedure zonder
  // aantal telt níet: daar is het aantal net wat ze tot een verkoop maakt, en
  // wat er gebruikt werd kan evengoed al op een bestelling staan.
  const units = (a) => (a.rooms == null || a.rooms === "" ? (a.type === "procedure" ? 0 : 1) : Math.max(0, Number(a.rooms) || 0));

  return {
    merge3, deepEqual, setMain, mainContact,
    normalizeFacts, syncPipeline, zonderProduct, stageStatus, autoStatus, syncRooms,
    byWhen, assigneeOf, tickOffDate, rooms, signedRooms, units,
    DB_VERSION, STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS: Object.keys(ACT_TYPES),
    ROOM_TYPES, SOLD_TYPES, typesFor, typesOffered, typesAmong, typesInAll, shared, productsOf, productOf, familiesFor, wantsFamily, factsFor, PRODUCTS, CMM_STATES, YES_NO, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, LANGUAGES, COUNTRIES, REGIONS, REGION_KEYS, regionOf, ROLES,
    esc, pickBox, syncPick, myProducts, productColor, productKind, wantsQuantity, stagesFor, furthest, pipelineView, emptyTargets,
  };
})();
