/* FollowUp Prion – statistieken.
 * Grafieken in gewone HTML: één tooltip, kleur per product (EndoQ = reeks 1, Ainex = reeks 2).
 *
 * Let op: de jaarfilter geldt voor contactmomenten. De cijfers van de
 * endoscopie-afdeling (kamers, coloscopieën) zijn de huidige toestand en
 * staan dus los van het gekozen jaar.
 */
window.FollowUpStats = (() => {
  "use strict";

  const I18N = window.FollowUpI18n;
  const t = (k, v) => I18N.t(k, v);

  // Vaste waarden en esc() komen uit domain.js, samen met app.js.
  const { PRODUCTS, STAGES, STATUSES, COUNTRIES, SCOPE_BRANDS, esc } = window.FollowUpDomain;
  const SERIES = { EndoQ: "var(--series-1)", Ainex: "var(--series-2)", "": "var(--series-none)" };
  // Nog geen doelcijfers afgesproken — vul ze in de app zelf aan.
  const DEFAULT_TARGETS = {
    2026: { EndoQ: 0, Ainex: 0 },
    2027: { EndoQ: 0, Ainex: 0 },
    2028: { EndoQ: 0, Ainex: 0 },
    2029: { EndoQ: 0, Ainex: 0 },
    2030: { EndoQ: 0, Ainex: 0 },
  };

  const view = { year: String(new Date().getFullYear()), product: "all" };
  let tip;

  const fmt = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(I18N.locale, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const rooms = (a) => Number(a.rooms) || 1;   // een installatie zonder aantal telt als één kamer
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const months = () => Array.from({ length: 12 }, (_, i) => new Date(2021, i, 1).toLocaleDateString(I18N.locale, { month: "short" }));
  const productLabel = (p) => p || (I18N.lang === "nl" ? "Geen product" : "No product");

  // Asmaxima waarvan de helft een rond getal is: 2, 4, 6, 8, 10 × 10^n
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    return [2, 4, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
  }

  function targetsFor(db, year) {
    return { ...(DEFAULT_TARGETS[year] || { EndoQ: 0, Ainex: 0 }), ...((db.targets || {})[year] || {}) };
  }

  // Alle contactmomenten, plat, met ziekenhuis erbij en gefilterd op jaar + product.
  function rows(db, { types, ignoreYear } = {}) {
    const out = [];
    for (const h of db.hospitals) {
      for (const a of h.activities) {
        if (types && !types.includes(a.type)) continue;
        if (!ignoreYear && view.year !== "all" && !a.date.startsWith(view.year)) continue;
        if (view.product !== "all" && a.product !== view.product) continue;
        out.push({ ...a, hospital: h });
      }
    }
    return out;
  }

  // Ziekenhuizen, gefilterd op het gekozen product.
  function hospitals(db) {
    return db.hospitals.filter((h) => view.product === "all" || h.products.includes(view.product));
  }

  // ---------- bouwstenen ----------
  function tile(value, label, sub) {
    return `<div class="s-tile"><b>${value}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  }

  function legend(series) {
    return `<div class="s-legend">${series.map((p) => `<span><i style="background:${SERIES[p]}"></i>${esc(productLabel(p))}</span>`).join("")}</div>`;
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
                  ${series.filter((s) => b.values[s]).map((s) => `<div style="flex:${b.values[s]};background:${SERIES[s]}"></div>`).join("")}
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
            ? series.filter((s) => i.values[s]).map((s) => `<div style="flex:${i.values[s]};background:${SERIES[s]}"></div>`).join("")
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
  function targetsCard(db, installs) {
    const year = view.year === "all" ? String(new Date().getFullYear()) : view.year;
    const goals = targetsFor(db, year);
    const byYear = installs.filter((a) => a.date.startsWith(year));
    const products = view.product === "all" ? PRODUCTS : [view.product];
    return card(`${t("stats.target")} ${year}`, products.map((p) => {
      const done = sum(byYear.filter((a) => a.product === p), rooms);
      const goal = Number(goals[p]) || 0;
      const pct = goal ? Math.min(100, (done / goal) * 100) : 0;
      return `<div class="s-target">
        <div class="s-target-head">
          <span><i style="background:${SERIES[p]}"></i>${p}</span>
          <span><b>${fmt(done)}</b> / <input type="number" min="0" data-target-year="${year}" data-target-product="${p}" value="${goal}" aria-label="${esc(t("stats.target"))} ${p} ${year}"> ${esc(t("stats.roomsLive").toLowerCase())}</span>
        </div>
        <div class="s-progress"><div style="width:${pct}%;background:${SERIES[p]}"></div></div>
        <small class="muted">${goal ? `${fmt((done / goal) * 100)}% ${esc(t("stats.reached"))}` : "—"}</small>
      </div>`;
    }).join("") + `<p class="muted">${esc(t("stats.targetsSub"))}</p>`);
  }

  function monthsCard(installs) {
    const M = months();
    let buckets;
    if (view.year === "all") {
      const now = new Date();
      buckets = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        return { key, short: M[d.getMonth()], label: `${M[d.getMonth()]} ${d.getFullYear()}`, values: {} };
      });
    } else {
      buckets = M.map((m, i) => ({ key: `${view.year}-${String(i + 1).padStart(2, "0")}`, short: m, label: `${m} ${view.year}`, values: {} }));
    }
    for (const a of installs) {
      const b = buckets.find((x) => a.date.startsWith(x.key));
      if (b) b.values[a.product || ""] = (b.values[a.product || ""] || 0) + rooms(a);
    }
    const series = seriesIn(installs);
    return card(t("stats.perMonth"), (series.length > 1 ? legend(series) : "") + columns(buckets, series.length ? series : ["EndoQ"]), "wide");
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
  function scopesCard(db) {
    const hs = hospitals(db);
    const items = SCOPE_BRANDS
      .map((b) => ({ label: b, total: hs.filter((h) => h.unit.scopeBrands.includes(b)).length }))
      .filter((i) => i.total)
      .sort((a, b) => b.total - a.total);
    return card(t("stats.scopes"), hbars(items, null, t("stats.noData")));
  }

  function tableCard(db) {
    const list = hospitals(db).slice().sort((a, b) =>
      (b.unit.roomsInstalled || 0) - (a.unit.roomsInstalled || 0) || a.name.localeCompare(b.name));
    if (!list.length) return card(t("stats.table"), `<p class="muted">${esc(t("stats.noData"))}</p>`, "wide");
    return card(`${t("stats.table")} (${list.length})`, `
      <div class="s-table-wrap"><table class="s-table">
        <thead><tr>
          <th>${esc(t("col.name"))}</th><th>${esc(t("col.country"))}</th><th>${esc(t("col.stage"))}</th>
          <th>${esc(t("col.products"))}</th><th class="num">${esc(t("unit.rooms"))}</th>
          <th class="num">${esc(t("unit.roomsDemo"))}</th><th class="num">${esc(t("unit.roomsInstalled"))}</th>
          <th class="num">${esc(t("unit.colosPerYear"))}</th><th>${esc(t("unit.existingAI"))}</th>
        </tr></thead>
        <tbody>${list.map((h) => `<tr>
          <td><i class="dot ${h.status}"></i> ${esc(h.name)}</td>
          <td>${esc(h.country ? t("country." + h.country + ".short") : "—")}</td>
          <td>${esc(t("stage." + h.stage))}</td>
          <td>${esc(h.products.join(", ") || "—")}</td>
          <td class="num">${h.unit.rooms ?? "—"}</td>
          <td class="num">${h.unit.roomsDemo ?? "—"}</td>
          <td class="num">${h.unit.roomsInstalled ?? "—"}</td>
          <td class="num">${h.unit.colosPerYear != null ? fmt(h.unit.colosPerYear) : "—"}</td>
          <td>${esc(h.unit.existingAI || "—")}</td>
        </tr>`).join("")}</tbody>
      </table></div>`, "wide");
  }

  // ---------- render ----------
  function render(db, el, onTargetsChange) {
    const years = new Set([String(new Date().getFullYear()), ...Object.keys(DEFAULT_TARGETS)]);
    for (const h of db.hospitals) for (const a of h.activities) years.add(a.date.slice(0, 4));
    const installs = rows(db, { types: ["installation"] });
    const allYearInstalls = rows(db, { types: ["installation"], ignoreYear: true });
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
          <div class="s-seg">${["all", ...PRODUCTS].map((p) => `<button data-stat-product="${p}" class="${view.product === p ? "active" : ""}">${p === "all" ? esc(t("stats.all")) : p}</button>`).join("")}</div>
        </div>
      </div>
      <div class="s-tiles">
        ${tile(fmt(hs.length), t("stats.hospitals"))}
        ${tile(fmt(hs.filter((h) => h.stage === "customer").length), t("stats.customers"))}
        ${tile(fmt(roomsLive), t("stats.roomsLive"), roomsTotal ? `${t("stats.coverage")}: ${fmt((roomsLive / roomsTotal) * 100)}%` : "")}
        ${tile(fmt(roomsDemo), t("stats.roomsDemo"))}
        ${tile(fmt(acts.length), t("section.activities"))}
        ${tile(colosCovered ? fmt(colosCovered) : "—", t("stats.colosCovered"), live.length ? `n = ${live.length}` : "")}
      </div>
      <div class="s-grid-cards">
        ${monthsCard(installs)}
        ${targetsCard(db, allYearInstalls)}
        ${hospitalsCard(db)}
        ${pipelineCard(db)}
        ${countryCard(db)}
        ${scopesCard(db)}
        ${activityCard(db)}
        ${tableCard(db)}
      </div>`;

    el.querySelector("[data-stat=year]").onchange = (e) => { view.year = e.target.value; render(db, el, onTargetsChange); };
    el.querySelectorAll("[data-stat-product]").forEach((b) => (b.onclick = () => { view.product = b.dataset.statProduct; render(db, el, onTargetsChange); }));
    el.querySelectorAll("[data-target-year]").forEach((inp) => (inp.onchange = () => {
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
