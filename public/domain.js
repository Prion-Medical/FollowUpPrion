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
    "evaluation", "customer", "on_hold", "not_interested",
  ];
  // Fases vóór de verkoop: een installatie of bestelling maakt er "customer" van.
  const PRE_SALE = ["prospect", "first_contact", "meeting", "demo_planned", "demo_installed", "evaluation"];
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
  const PRODUCTS = ["EndoQ", "Ainex"];
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
  const SCOPE_BRANDS = ["Olympus", "Pentax", "Fujifilm", "other"];
  // De toren staat los van de scopes — daar hangt EndoQ of
  // Ainex aan, dus
  // daar valt of staat de aansluiting mee. Bij deze drie komt hij van
  // dezelfde fabrikant, vandaar dezelfde lijst; loopt dat ooit uiteen, dan
  // splits je ze hier.
  const PROCESSOR_BRANDS = SCOPE_BRANDS;
  // Diensten waar een contactpersoon toe behoort. Niet alleen de artsen
  // beslissen mee: ICT, aankoop en de biomedische dienst evengoed.
  const DEPARTMENTS = ["physician", "endoscopy", "it", "purchasing", "biomed", "admin", "other"];
  const SECTORS = ["public", "private", "university"];
  const COUNTRIES = ["BE", "NL", "LU"];
  // Rollen, van veel naar weinig rechten. In de databank staat de sleutel; wat
  // elke rol precies mag staat in storage.js (RIGHTS) en wordt afgedwongen in
  // supabase/schema.sql.
  const ROLES = ["admin", "editor", "contributor", "viewer"];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // De uitklapper met vinkjes. Staat hier omdat drie schermen hem gebruiken:
  // het bereik van een gebruiker en de producten van een contactpersoon in
  // app.js, en de filter op de statistiekpagina in stats.js. Een <select
  // multiple> kan dit ook, maar die is op een telefoon niet te bedienen en
  // toont niet wat er aanstaat zonder open te klappen.
  //
  // De oproeper geeft de regels zelf mee: elk scherm hangt er zijn eigen
  // data-velden aan, en die vangt het met delegatie weer op.
  // type "radio" maakt er een keuze van één. Die vorm gebruiken de dialogen
  // van een contactmoment en een gepland moment: zo'n moment hoort bij één
  // product. Dat is geen vergetelheid — de kamers van een installatie tellen
  // mee voor het doelcijfer van dat product, en "drie kamers voor allebei" is
  // geen getal dat ergens eerlijk op te tellen valt.
  const pickRow = (attrs, label, checked, cls, type) =>
    `<label class="${esc(cls || "")}"><input type="${esc(type || "checkbox")}" ${attrs} ${checked ? "checked" : ""}>${esc(label)}</label>`;
  // De samenvatting staat in een eigen span en niet los in de summary. Twee
  // redenen: het pijltje ernaast is een flex-item en blijft zo op dezelfde
  // regel staan, en de oproepers die de tekst bijwerken met textContent
  // zouden dat pijltje anders mee overschrijven. De data-velden gaan daarom
  // op die span, waar die oproepers ze ook zoeken.
  const pickBox = (label, rows, summaryAttrs, open) =>
    `<details class="pick" ${open ? "open" : ""}><summary><span class="pick-label" ${summaryAttrs || ""}>${esc(label)}</span></summary>
       <div class="pick-list">${rows}</div></details>`;

  return {
    DB_VERSION, STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS: Object.keys(ACT_TYPES),
    ROOM_TYPES, PRODUCTS, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, COUNTRIES, ROLES,
    esc, pickRow, pickBox, myProducts, productColor, emptyTargets,
  };
})();
