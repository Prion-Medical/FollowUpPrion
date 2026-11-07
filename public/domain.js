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
  const PRODUCTS = ["EndoQ", "Ainex"];
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

  return {
    DB_VERSION, STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS: Object.keys(ACT_TYPES),
    ROOM_TYPES, PRODUCTS, SCOPE_BRANDS, PROCESSOR_BRANDS, DEPARTMENTS, SECTORS, COUNTRIES, ROLES, esc,
  };
})();
