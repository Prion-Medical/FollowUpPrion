/* FollowUp Prion – statistieken.
 * Grafieken in gewone HTML: één tooltip, kleur per product (EndoQ = reeks 1, Ainex = reeks 2).
 *
 * Let op: de jaarfilter geldt voor contactmomenten. De cijfers van de
 * endoscopie-afdeling (kamers, coloscopieën) zijn de huidige toestand en
 * staan dus los van het gekozen jaar.
 *
 * De grafiek "actieve abonnementen per maand" telt over de jaargrens heen: daar
 * kiest de jaarfilter enkel welke twaalf maanden je ziet, niet wat meetelt.
 */
window.FollowUpStats = (() => {
  "use strict";

  const I18N = window.FollowUpI18n;
  const t = (k, v) => I18N.t(k, v);

  // Vaste waarden en esc() komen uit domain.js, samen met app.js.
  const { PRODUCTS, STAGES, STATUSES, COUNTRIES, SCOPE_BRANDS, PROCESSOR_BRANDS,
          esc, pickBox, myProducts, productColor, productKind, emptyTargets } = window.FollowUpDomain;
  const scopeLabel = (b) => (b === "other" ? t("scope.other") : b);
  // Een doelcijfer aanpassen is schrijven. Zonder dat recht staat het getal er
  // nog wel — het hoort bij de cijfers — maar op slot. storage.js is op dit
  // punt al geladen; de vangnetten zijn er voor het geval dat ooit verschuift.
  const canWrite = () => !!(window.FollowUpStore && window.FollowUpStore.can && window.FollowUpStore.can.write);
  // Nog geen doelcijfers afgesproken — vul ze in de app zelf aan. De jaren
  // schuiven mee met de kalender: dit jaar en de vier volgende.
  const DEFAULT_TARGETS = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [String(new Date().getFullYear() + i), emptyTargets()]));

  // chart: "subs" = actieve abonnementen (EndoQ en Ainex gaan per abonnement),
  // "installs" = nieuwe installaties per maand, voor als er ooit een product
  // bijkomt dat je één keer verkoopt.
  // products leeg = geen filter, dus alles. Dezelfde betekenis als een leeg
  // bereik op een gebruiker: niets aangevinkt beperkt niets.
  // pickOpen onthoudt of de uitklapper openstond. Anders dan bij de filters in
  // de zijbalk kan deze pagina niet volstaan met de lijst bijwerken: een ander
  // product verandert élke grafiek, dus gaat alles opnieuw door de render — en
  // daar gaat een open uitklapper in mee. Vandaar dit ene veldje.
  const view = { year: String(new Date().getFullYear()), products: [], chart: "subs", pickOpen: false };
  let tip;

  const fmt = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(I18N.locale, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const rooms = (a) => Number(a.rooms) || 1;   // een installatie zonder aantal telt als één kamer
  // Een stopzetting telt negatief, zodat "actief" echt actief blijft.
  const signedRooms = (a) => (a.type === "cancellation" ? -rooms(a) : rooms(a));
  // Bestelde stuks. Zonder aantal telt een bestelling als één, maar een
  // ingevulde nul is nul: een gratis proefzending is geen verkoop.
  const units = (a) => (a.rooms == null || a.rooms === "" ? 1 : Math.max(0, Number(a.rooms) || 0));
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const months = () => Array.from({ length: 12 }, (_, i) => new Date(2021, i, 1).toLocaleDateString(I18N.locale, { month: "short" }));
  const productLabel = (p) => p || t("stats.noProduct");

  // Asmaxima waarvan de helft een rond getal is: 2, 4, 6, 8, 10 × 10^n
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    return [2, 4, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
  }

  function targetsFor(db, year) {
    return { ...(DEFAULT_TARGETS[year] || emptyTargets()), ...((db.targets || {})[year] || {}) };
  }

  // Alle contactmomenten, plat, met ziekenhuis erbij en gefilterd op jaar + product.
  function rows(db, { types, ignoreYear } = {}) {
    const out = [];
    for (const h of db.hospitals) {
      for (const a of h.activities) {
        if (types && !types.includes(a.type)) continue;
        if (!ignoreYear && view.year !== "all" && !a.date.startsWith(view.year)) continue;
        if (view.products.length && !view.products.includes(a.product)) continue;
        out.push({ ...a, hospital: h });
      }
    }
    return out;
  }

  // Ziekenhuizen, gefilterd op het gekozen product.
  function hospitals(db) {
    return db.hospitals.filter((h) => !view.products.length || view.products.some((p) => h.products.includes(p)));
  }

  // Fase en kleur van een ziekenhuis, voor de producten waarop gefilterd is.
  const shown = (h) => pipelineView(h, view.products);

  // ---------- bouwstenen ----------
  function tile(value, label, sub) {
    return `<div class="s-tile"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  }

  function legend(series) {
    return `<div class="s-legend">${series.map((p) => `<span><i style="background:${productColor(p)}"></i>${esc(productLabel(p))}</span>`).join("")}</div>`;
  }

  // Verticale gestapelde staven (bv. per maand).
  function columns(buckets, series) {
    const max = niceMax(Math.max(1, ...buckets.map((b) => sum(series, (s) => b.values[s] || 0))));
    const ticks = [max, max / 2, 0];
    return `
      <div class="s-cols">
        <div class="s-yaxis">${ticks.map((v) => `<span>${fmt(v)}</span>`).join("")}</div>
        <div class="s-plot">
          ${ticks.map((v) => `<div class="s-grid" style="bottom:${(v / max) * 100}%"></div>`).join("")}
          <div class="s-bars">
            ${buckets.map((b) => {
              const total = sum(series, (s) => b.values[s] || 0);
              const tipText = [`${b.label}: ${total}`, ...series.filter((s) => b.values[s]).map((s) => `${productLabel(s)}: ${b.values[s]}`)].join("\n");
              return `<div class="s-col" data-tip="${esc(tipText)}" tabindex="0">
                <div class="s-stack" style="height:${(total / max) * 100}%">
                  ${series.filter((s) => b.values[s]).map((s) => `<div style="flex:${b.values[s]};background:${productColor(s)}"></div>`).join("")}
                </div>
                <span class="s-xlabel">${esc(b.short)}</span>
              </div>`;
            }).join("")}
          </div>
        </div>
      </div>`;
  }

  // Horizontale (gestapelde) staven met label links en totaal rechts.
  function hbars(items, series, empty) {
    if (!items.length) return `<p class="muted">${esc(empty)}</p>`;
    const max = Math.max(1, ...items.map((i) => i.total));
    return `<div class="s-hbars">${items.map((i) => {
      const tipText = [`${i.label}: ${i.total}`, ...(series ? series.filter((s) => i.values[s]).map((s) => `${productLabel(s)}: ${i.values[s]}`) : [])].join("\n");
      return `<div class="s-hrow" data-tip="${esc(tipText)}" tabindex="0">
        <span class="s-hlabel">${esc(i.label)}</span>
        <div class="s-htrack"><div class="s-hbar" style="width:${(i.total / max) * 100}%">
          ${series
            ? series.filter((s) => i.values[s]).map((s) => `<div style="flex:${i.values[s]};background:${productColor(s)}"></div>`).join("")
            : `<div style="flex:1;background:${i.color || "var(--series-1)"}"></div>`}
        </div></div>
        <span class="s-hval">${fmt(i.total)}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function card(title, body, extra = "") {
    return `<section class="s-card ${extra}"><h3>${esc(title)}</h3>${body}</section>`;
  }

  function seriesIn(list) {
    const present = new Set(list.map((a) => a.product || ""));
    return [...PRODUCTS, ""].filter((p) => present.has(p));
  }

  // ---------- secties ----------
  function targetsCard(db, events) {
    const year = view.year === "all" ? String(new Date().getFullYear()) : view.year;
    const goals = targetsFor(db, year);
    const byYear = events.filter((a) => a.date.startsWith(year));
    // Het doelcijfer telt kamers, en dat zegt alleen iets over een product dat
    // per abonnement gaat. Een product per ingreep krijgt hier voorlopig geen
    // rij — liever geen doel dan één in de verkeerde eenheid.
    const products = (view.products.length ? view.products : myProducts())
      .filter((p) => productKind(p) === "subscription");
    if (!products.length) return "";
    return card(`${t("stats.target")} ${year}`, products.map((p) => {
      // Netto voor dat jaar: wat erbij kwam min wat er weer stopte.
      const done = Math.max(0, sum(byYear.filter((a) => a.product === p), signedRooms));
      const goal = Number(goals[p]) || 0;
      const pct = goal ? Math.min(100, (done / goal) * 100) : 0;
      return `<div class="s-target">
        <div class="s-target-head">
          <span><i style="background:${productColor(p)}"></i>${esc(p)}</span>
          <span><b>${fmt(done)}</b> / <input type="number" min="0" data-target-year="${esc(year)}" data-target-product="${esc(p)}" value="${goal}" ${canWrite() ? "" : "readonly"} aria-label="${esc(t("stats.target"))} ${esc(p)} ${esc(year)}"> ${esc(t("stats.roomsLive").toLowerCase())}</span>
        </div>
        <div class="s-progress"><div style="width:${pct}%;background:${productColor(p)}"></div></div>
        <small class="muted">${goal ? `${fmt((done / goal) * 100)}% ${esc(t("stats.reached"))}` : "—"}</small>
      </div>`;
    }).join("") + `<p class="muted">${esc(t("stats.targetsSub"))}</p>`);
  }

  // Twaalf maanden: het gekozen jaar, of de laatste twaalf bij "alle jaren".
  function monthBuckets() {
    const M = months();
    if (view.year === "all") {
      const now = new Date();
      return Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        return { key, short: M[d.getMonth()], label: `${M[d.getMonth()]} ${d.getFullYear()}`, values: {} };
      });
    }
    return M.map((m, i) => ({ key: `${view.year}-${String(i + 1).padStart(2, "0")}`, short: m, label: `${m} ${view.year}`, values: {} }));
  }

  // Actieve abonnementen per maand: alles wat tot en met die maand geïnstalleerd
  // is, min wat er ondertussen stopte. Dit is een stand, geen optelsom per
  // maand, dus het loopt over de jaargrens heen.
  function subscriptionsCard(events) {
    const buckets = monthBuckets();
    for (const b of buckets) {
      for (const a of events) {
        if (!a.date || a.date.slice(0, 7) > b.key) continue;
        b.values[a.product || ""] = (b.values[a.product || ""] || 0) + signedRooms(a);
      }
      // Meer stopgezet dan geïnstalleerd kan niet; dat is gewoon nul.
      for (const p of Object.keys(b.values)) b.values[p] = Math.max(0, b.values[p]);
    }
    const series = seriesIn(events);
    return card(t("stats.activeSubs"), (series.length > 1 ? legend(series) : "") + columns(buckets, series.length ? series : [myProducts()[0]]), "wide");
  }

  // Nieuwe installaties per maand. Voor EndoQ en Ainex zegt de grafiek hierboven
  // meer, maar deze blijft staan: voor een product dat je één keer verkoopt in
  // plaats van per abonnement is dít het juiste cijfer.
  function installationsCard(installs) {
    const buckets = monthBuckets();
    for (const a of installs) {
      const b = buckets.find((x) => x.key === (a.date || "").slice(0, 7));
      if (b) b.values[a.product || ""] = (b.values[a.product || ""] || 0) + rooms(a);
    }
    const series = seriesIn(installs);
    return card(t("stats.perMonth"), (series.length > 1 ? legend(series) : "") + columns(buckets, series.length ? series : [myProducts()[0]]), "wide");
  }

  // Bestellingen per maand, voor de producten die per ingreep verbruikt worden.
  // Geen stand zoals de abonnementen maar een optelsom per maand: wat er die
  // maand besteld is. Een bestelling zonder aantal telt als één.
  function ordersCard(orders) {
    const buckets = monthBuckets();
    for (const a of orders) {
      const b = buckets.find((x) => x.key === (a.date || "").slice(0, 7));
      if (b) b.values[a.product || ""] = (b.values[a.product || ""] || 0) + units(a);
    }
    const series = seriesIn(orders);
    return card(t("stats.orders"), (series.length > 1 ? legend(series) : "") + columns(buckets, series.length ? series : [myProducts().find((p) => productKind(p) === "procedure")]), "wide");
  }

  function hospitalsCard(db) {
    const items = hospitals(db)
      .filter((h) => h.unit.roomsInstalled)
      .map((h) => ({ label: h.name, total: h.unit.roomsInstalled }))
      .sort((a, b) => b.total - a.total);
    return card(t("stats.perHospital"), hbars(items, null, t("stats.noData")));
  }

  function countryCard(db) {
    const hs = hospitals(db);
    const items = COUNTRIES.map((c) => ({ label: t("country." + c), total: hs.filter((h) => h.country === c).length }))
      .filter((i) => i.total);
    return card(t("stats.perCountry"), hbars(items, null, t("stats.noData")));
  }

  function pipelineCard(db) {
    const hs = hospitals(db);
    const statusTiles = `<div class="s-status">${STATUSES.map((k) =>
      `<div><i class="dot ${k}"></i><b>${hs.filter((h) => h.status === k).length}</b><span>${esc(t("status." + k + ".short"))}</span></div>`).join("")}</div>`;
    const items = STAGES.map((s) => ({ label: t("stage." + s), total: hs.filter((h) => h.stage === s).length })).filter((i) => i.total);
    return card(t("stats.pipeline"), statusTiles + hbars(items, null, t("stats.noData")));
  }

  function activityCard(db) {
    const acts = rows(db);
    const counts = {};
    for (const a of acts) counts[a.type] = (counts[a.type] || 0) + 1;
    const items = Object.entries(counts)
      .map(([type, total]) => ({ label: t("act." + type), total }))
      .sort((a, b) => b.total - a.total);
    return card(t("stats.activity"), hbars(items, null, t("stats.noData")));
  }

  // Welke scope-merken komen voor in de pijplijn? Bepaalt mee of EndoQ of Ainex past.
  // Welke merken staan er in de pijplijn — de scopes, en de videoprocessors
  // waar EndoQ of Ainex op aangesloten moet worden.
  function brandCard(db, title, brands, key) {
    const hs = hospitals(db);
    const items = brands
      .map((b) => ({ label: scopeLabel(b), total: hs.filter((h) => h.unit[key].includes(b)).length }))
      .filter((i) => i.total)
      .sort((a, b) => b.total - a.total);
    return card(title, hbars(items, null, t("stats.noData")));
  }
  const scopesCard = (db) => brandCard(db, t("stats.scopes"), SCOPE_BRANDS, "scopeBrands");
  const processorsCard = (db) => brandCard(db, t("stats.processors"), PROCESSOR_BRANDS, "processorBrands");

  // De kolommen volgen de soort product in de keuze: kamers en coloscopieën
  // zeggen alleen iets bij een abonnement, bestellingen alleen bij een product
  // per ingreep.
  function tableCard(db, metSubs, orders) {
    const besteld = (h) => sum(orders.filter((a) => a.hospital === h), units);
    const list = hospitals(db).slice().sort((a, b) =>
      (metSubs ? (b.unit.roomsInstalled || 0) - (a.unit.roomsInstalled || 0) : besteld(b) - besteld(a)) || a.name.localeCompare(b.name));
    if (!list.length) return card(t("stats.table"), `<p class="muted">${esc(t("stats.noData"))}</p>`, "wide");
    return card(`${t("stats.table")} (${list.length})`, `
      <div class="s-table-wrap"><table class="s-table">
        <thead><tr>
          <th>${esc(t("col.name"))}</th><th>${esc(t("col.country"))}</th><th>${esc(t("col.stage"))}</th>
          <th>${esc(t("col.products"))}</th>${metSubs ? `<th class="num">${esc(t("unit.rooms"))}</th>
          <th class="num">${esc(t("unit.roomsDemo"))}</th><th class="num">${esc(t("unit.roomsInstalled"))}</th>
          <th class="num">${esc(t("unit.colosPerYear"))}</th><th>${esc(t("unit.existingAI"))}</th>` : ""}
          ${orders.length ? `<th class="num">${esc(t("stats.ordersTile"))}</th>` : ""}
        </tr></thead>
        <tbody>${list.map((h) => `<tr>
          <td><i class="dot ${esc(shown(h).status)}"></i> ${esc(h.name)}</td>
          <td>${esc(h.country ? t("country." + h.country + ".short") : "—")}</td>
          <td>${esc(t("stage." + shown(h).stage))}</td>
          <td>${esc(h.products.join(", ") || "—")}</td>${metSubs ? `
          <td class="num">${esc(h.unit.rooms ?? "—")}</td>
          <td class="num">${esc(h.unit.roomsDemo ?? "—")}</td>
          <td class="num">${esc(h.unit.roomsInstalled ?? "—")}</td>
          <td class="num">${h.unit.colosPerYear != null ? fmt(h.unit.colosPerYear) : "—"}</td>
          <td>${esc(h.unit.existingAI || "—")}</td>` : ""}
          ${orders.length ? `<td class="num">${besteld(h) ? fmt(besteld(h)) : "—"}</td>` : ""}
        </tr>`).join("")}</tbody>
      </table></div>`, "wide");
  }

  // ---------- render ----------
  function render(db, el, onTargetsChange) {
    // Buiten bereik geraakt (een beheerder heeft je afscherming aangepast):
    // terug naar alles, anders staan er nullen voor iets wat je niet ziet.
    // Is het bereik ondertussen versmald, dan vallen de vinkjes die er niet
    // meer bij horen weg in plaats van een lege grafiek op te leveren.
    view.products = view.products.filter((p) => myProducts().includes(p));
    const years = new Set([String(new Date().getFullYear()), ...Object.keys(DEFAULT_TARGETS)]);
    for (const h of db.hospitals) for (const a of h.activities) years.add(a.date.slice(0, 4));
    // Welke soorten product zitten er in de keuze? Daar hangt van af wat er te
    // tonen valt: abonnementen, kamers en torens bij het ene, bestellingen bij
    // het andere, en allebei als de keuze allebei bevat. Een contactmoment
    // zonder product telt mee als abonnement, zoals het altijd deed.
    const keuze = view.products.length ? view.products : myProducts();
    const metSubs = keuze.some((p) => productKind(p) === "subscription");
    const metOrders = keuze.some((p) => productKind(p) === "procedure");
    const isSub = (a) => productKind(a.product) === "subscription";
    const installs = rows(db, { types: ["installation"] }).filter(isSub);
    const subsEvents = rows(db, { types: ["installation", "cancellation"], ignoreYear: true }).filter(isSub);
    const orders = metOrders ? rows(db, { types: ["order"] }).filter((a) => !isSub(a)) : [];
    const acts = rows(db);
    const hs = hospitals(db);
    const live = hs.filter((h) => h.unit.roomsInstalled);
    const roomsLive = sum(hs, (h) => h.unit.roomsInstalled || 0);
    const roomsDemo = sum(hs, (h) => h.unit.roomsDemo || 0);
    const roomsTotal = sum(hs, (h) => h.unit.rooms || 0);
    const colosCovered = sum(live, (h) => h.unit.colosPerYear || 0);

    el.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("nav.stats"))}</h2>
        <div class="s-filters">
          <label>${esc(t("stats.year"))} <select data-stat="year">
            <option value="all" ${view.year === "all" ? "selected" : ""}>${esc(t("stats.all"))}</option>
            ${[...years].sort().reverse().filter((y) => /^\d{4}$/.test(y)).map((y) => `<option ${y === view.year ? "selected" : ""}>${y}</option>`).join("")}
          </select></label>
          <label>${esc(t("stats.product"))} ${pickBox([
            { attrs: `data-stat-product="all"`, label: t("stats.all"),
              checked: !view.products.length, cls: "pick-all" },
            ...myProducts().map((p) => ({
              attrs: `data-stat-product="${esc(p)}"`, label: p, checked: view.products.includes(p),
            })),
          ], t("stats.all"), view.pickOpen)}</label>
          ${!metSubs ? "" : `<div class="s-seg">${[["subs", "stats.chartSubs"], ["installs", "stats.chartInstalls"]].map(([k, key]) => `<button data-stat-chart="${k}" class="${view.chart === k ? "active" : ""}">${esc(t(key))}</button>`).join("")}</div>`}
        </div>
      </div>
      <div class="s-tiles">
        ${tile(fmt(hs.length), t("stats.hospitals"))}
        ${tile(fmt(hs.filter((h) => h.stage === "customer").length), t("stats.customers"))}
        ${!metSubs ? "" : tile(fmt(roomsLive), t("stats.roomsLive"), roomsTotal ? `${t("stats.coverage")}: ${fmt((roomsLive / roomsTotal) * 100)}%` : "")
          + tile(fmt(roomsDemo), t("stats.roomsDemo"))}
        ${!metOrders ? "" : tile(fmt(sum(orders, units)), t("stats.ordersTile"))}
        ${tile(fmt(acts.length), t("section.activities"))}
        ${!metSubs ? "" : tile(colosCovered ? fmt(colosCovered) : "—", t("stats.colosCovered"), live.length ? `n = ${live.length}` : "")}
      </div>
      <div class="s-grid-cards">
        ${!metSubs ? "" : (view.chart === "subs" ? subscriptionsCard(subsEvents) : installationsCard(installs))}
        ${!metOrders ? "" : ordersCard(orders)}
        ${targetsCard(db, subsEvents)}
        ${!metSubs ? "" : hospitalsCard(db)}
        ${pipelineCard(db)}
        ${countryCard(db)}
        ${!metSubs ? "" : scopesCard(db) + processorsCard(db)}
        ${activityCard(db)}
        ${tableCard(db, metSubs, orders)}
      </div>`;

    el.querySelector("[data-stat=year]").onchange = (e) => { view.year = e.target.value; render(db, el, onTargetsChange); };
    // "Alle" is hier het lege antwoord: aanvinken wist de losse vinkjes, en het
    // laatste vinkje uitzetten komt op hetzelfde neer.
    el.querySelectorAll("[data-stat-product]").forEach((b) => (b.onchange = () => {
      const p = b.dataset.statProduct;
      if (p === "all") view.products = [];
      else view.products = b.checked ? [...view.products, p] : view.products.filter((x) => x !== p);
      render(db, el, onTargetsChange);
    }));
    // Elke wijziging tekent de pagina opnieuw, en dan zou de uitklapper
    // dichtklappen na elk vinkje. We onthouden of hij openstond.
    const pick = el.querySelector(".pick");
    if (pick) pick.ontoggle = () => { view.pickOpen = pick.open; };
    el.querySelectorAll("[data-stat-chart]").forEach((b) => (b.onclick = () => { view.chart = b.dataset.statChart; render(db, el, onTargetsChange); }));
    el.querySelectorAll("[data-target-year]").forEach((inp) => (inp.onchange = () => {
      if (!canWrite()) return;
      const y = inp.dataset.targetYear;
      db.targets ||= {};
      db.targets[y] = { ...targetsFor(db, y), [inp.dataset.targetProduct]: Math.max(0, Number(inp.value) || 0) };
      onTargetsChange();
      render(db, el, onTargetsChange);
    }));
    bindTooltip(el);
  }

  function bindTooltip(el) {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "s-tip";
      tip.hidden = true;
      document.body.append(tip);
    }
    const show = (target, x, y) => {
      const lines = target.dataset.tip.split("\n");
      tip.replaceChildren(...lines.map((l, i) => {
        const div = document.createElement("div");
        if (i === 0) { const b = document.createElement("b"); b.textContent = l; div.append(b); } else div.textContent = l;
        return div;
      }));
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + "px";
      tip.style.top = Math.max(8, y - r.height - 10) + "px";
    };
    el.onpointermove = (e) => {
      const target = e.target.closest("[data-tip]");
      if (target) show(target, e.clientX, e.clientY); else tip.hidden = true;
    };
    el.onpointerleave = () => (tip.hidden = true);
    el.onfocusin = (e) => {
      const target = e.target.closest("[data-tip]");
      if (target) { const r = target.getBoundingClientRect(); show(target, r.left + r.width / 2, r.top); }
    };
    el.onfocusout = () => (tip.hidden = true);
  }

  return { render, hideTip: () => tip && (tip.hidden = true) };
})();
