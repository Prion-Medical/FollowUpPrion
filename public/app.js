/* FollowUp Prion – opvolging EndoQ & Ainex in de Benelux.
 * Follow-up of EndoQ & Ainex in the Benelux. */
(() => {
  "use strict";

  const I18N = window.FollowUpI18n;
  const t = (k, v) => I18N.t(k, v);

  // Vaste waarden en esc() staan in domain.js: stats.js heeft ze ook nodig, en
  // zo moet een nieuwe fase of een nieuw merk maar op één plaats bij.
  const {
    STATUSES, STAGES, PRE_SALE, ACT_TYPES, ACT_TYPE_KEYS, ROOM_TYPES, PRODUCTS,
    SCOPE_BRANDS, SECTORS, COUNTRIES, esc,
  } = window.FollowUpDomain;
  // Scope-merken zijn eigennamen; enkel "other" is een sleutel met vertaling.
  const scopeLabel = (b) => (b === "other" ? t("scope.other") : b);
  // Benelux: west/zuid → oost/noord.
  const REGION_BOUNDS = [[49.3, 2.3], [53.7, 7.4]];
  const REGION_BBOX = [2.3, 49.3, 7.4, 53.7];

  const state = {
    db: { version: 1, hospitals: [] },
    selectedId: null,
    filter: { status: "all", product: "all", country: "all", query: "" },
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
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
  function isOverdue(h) {
    return !!h.nextActionDate && h.nextActionDate < today();
  }
  function hasDemoPlanned(h) {
    return !!h.demoDate && h.demoDate >= today();
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
  function scheduleSave() {
    $("#saveState").textContent = t("save.saving");
    $("#saveState").classList.remove("error");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    try {
      await store.save(state.db);
      $("#saveState").textContent = t("save.saved");
    } catch (e) {
      $("#saveState").textContent = t("save.failed");
      $("#saveState").classList.add("error");
      if (e instanceof store.ConflictError) {
        showBanner(t("save.conflict"), true);
      } else {
        const hint = store.mode === "local" ? t("save.errorLocal") : t("save.errorOnline");
        showBanner(t("save.errorBody", { hint, msg: e.message }));
      }
    }
  }
  window.addEventListener("beforeunload", (e) => {
    if (saveTimer && $("#saveState").textContent !== t("save.saved")) { e.preventDefault(); }
  });
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

  // Oudere of ingevoerde data kan velden missen of een verkeerd type hebben.
  // Alles wordt hier naar de verwachte vorm gebracht, zodat de rest van de app
  // mag rekenen op strings, getallen en lijsten. Status, fase, land, sector en
  // het type contactmoment zijn vaste sleutels: iets anders vervangen we door
  // de standaardwaarde — zo komt er ook nooit opmaak of script in de data.
  // Nieuw veld toegevoegd? Vul het hier aan, anders breekt oudere data.
  function normalizeContact(c) {
    c.id = str(c.id) || uid();
    for (const k of ["name", "role", "phone", "email", "address", "product", "notes"]) c[k] = str(c[k]);
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
    a.rooms = ROOM_TYPES.includes(a.type) ? numOrNull(a.rooms) : null;
    return a;
  }
  function normalize(h) {
    h.id = str(h.id) || uid();
    h.name = str(h.name).trim() || "—";
    if (!Array.isArray(h.contacts)) h.contacts = [];
    if (!Array.isArray(h.activities)) h.activities = [];
    if (!Array.isArray(h.products)) h.products = [];
    h.contacts.forEach(normalizeContact);
    h.activities.forEach(normalizeActivity);
    h.products = h.products.filter((p) => typeof p === "string");
    h.status = STATUSES.includes(h.status) ? h.status : "red";
    h.stage = STAGES.includes(h.stage) ? h.stage : "prospect";
    h.country = COUNTRIES.includes(h.country) ? h.country : "";
    h.sector = SECTORS.includes(h.sector) ? h.sector : "";
    h.address = str(h.address);
    h.notes = str(h.notes);
    h.nextAction = str(h.nextAction);
    h.nextActionDate = dateOrEmpty(h.nextActionDate);
    h.demoDate = dateOrEmpty(h.demoDate);
    h.createdAt = dateOrEmpty(h.createdAt) || today();
    // Een halve locatie is geen locatie: de kaart rekent op lat én lng.
    h.lat = coord(h.lat, 90);
    h.lng = coord(h.lng, 180);
    if (h.lat == null || h.lng == null) { h.lat = null; h.lng = null; }
    if (!h.unit || typeof h.unit !== "object" || Array.isArray(h.unit)) h.unit = {};
    h.unit.scopeBrands = Array.isArray(h.unit.scopeBrands)
      ? h.unit.scopeBrands
          .filter((b) => typeof b === "string")
          // Vroeger bewaarde de app hier de getoonde tekst; nu de sleutel.
          .map((b) => (b === "Andere / Other" ? "other" : b))
      : [];
    for (const k of ["rooms", "roomsDemo", "roomsInstalled", "colosPerYear"]) h.unit[k] = numOrNull(h.unit[k]);
    h.unit.scopeNotes = str(h.unit.scopeNotes);
    h.unit.existingAI = str(h.unit.existingAI);
    h.unit.screening = !!h.unit.screening;
    return h;
  }

  // ---------- kaart ----------
  const map = L.map("map", { zoomControl: true }).fitBounds(REGION_BOUNDS);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  function pinIcon(h) {
    const cls = ["pin", h.status, h.id === state.selectedId ? "selected" : "", h.id === state.dragId ? "dragging" : ""].join(" ");
    return L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
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
    const hay = [h.name, h.address, h.unit.scopeNotes, h.unit.existingAI, h.notes,
      ...h.contacts.flatMap((c) => [c.name, c.role, c.address, c.email])]
      .join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }
  function visibleHospitals() {
    const { status, product, country, query } = state.filter;
    return state.db.hospitals.filter((h) =>
      (status === "all" || h.status === status) &&
      (product === "all" || (product === "overdue" ? isOverdue(h) : h.products.includes(product))) &&
      (country === "all" || h.country === country) &&
      matchesQuery(h, query));
  }

  function renderList() {
    const order = { green: 0, orange: 1, red: 2 };
    const q = state.filter.query.toLowerCase();
    const nameHit = (h) => (q && h.name.toLowerCase().includes(q) ? 0 : 1);
    const items = visibleHospitals().sort((a, b) =>
      nameHit(a) - nameHit(b) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const ul = $("#list");
    if (!items.length) {
      ul.innerHTML = `<li class="empty">${esc(t("list.empty"))}</li>`;
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      const primary = h.contacts.find((c) => c.primary);
      const bits = [t("stage." + h.stage)];
      if (h.country) bits.push(t("country." + h.country + ".short"));
      if (h.unit.roomsInstalled) bits.push(`${h.unit.roomsInstalled}× ${t("stats.roomsLive").toLowerCase()}`);
      if (lc) bits.push(t("rel.last") + " " + relDays(lc));
      return `<li data-id="${h.id}" class="${h.id === state.selectedId ? "selected" : ""}">
        <i class="dot ${h.status}"></i>
        <div>
          <div class="name">${esc(h.name)}${isOverdue(h) ? `<span class="badge">${esc(t("badge.overdue"))}</span>` : ""}${h.lat == null ? `<span class="badge neutral">${esc(t("map.noLocation"))}</span>` : ""}</div>
          <div class="meta">${esc(bits.join(" · "))}</div>
          ${primary ? `<div class="meta">★ ${esc(primary.name)}</div>` : ""}
        </div>
      </li>`;
    }).join("");
  }
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id, true);
  });

  function bindChips(containerSel, key) {
    $(containerSel).addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      $(containerSel).querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
      state.filter[key] = b.dataset[key];
      renderList();
      renderMarkers();
    });
  }
  bindChips("#statusFilters", "status");
  bindChips("#productFilters", "product");
  bindChips("#countryFilters", "country");

  $("#search").addEventListener("input", (e) => {
    state.filter.query = e.target.value.trim();
    renderList();
    renderMarkers();
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("#list li[data-id]");
      if (first) select(first.dataset.id, true);
    }
  });

  function renderKpis() {
    const hs = state.db.hospitals;
    const n = (s) => hs.filter((h) => h.status === s).length;
    const sum = (f) => hs.reduce((s, h) => s + (f(h) || 0), 0);
    const demos = hs.filter(hasDemoPlanned).length;
    const late = hs.filter(isOverdue).length;
    $("#kpis").innerHTML = `
      <div class="kpi"><b style="color:var(--green)">${n("green")}</b><span>${esc(t("status.green.short"))}</span></div>
      <div class="kpi"><b style="color:var(--orange)">${n("orange")}</b><span>${esc(t("status.orange.short"))}</span></div>
      <div class="kpi"><b style="color:var(--red)">${n("red")}</b><span>${esc(t("status.red.short"))}</span></div>
      <div class="kpi"><b>${demos}</b><span>${esc(t("kpi.demosPlanned"))}</span></div>
      <div class="kpi"><b>${sum((h) => h.unit.roomsDemo)}</b><span>${esc(t("kpi.roomsDemo"))}</span></div>
      <div class="kpi"><b>${sum((h) => h.unit.roomsInstalled)}</b><span>${esc(t("kpi.roomsInstalled"))}</span></div>
      <div class="kpi"><b style="${late ? "color:var(--red)" : ""}">${late}</b><span>${esc(t("kpi.overdue"))}</span></div>`;
  }

  // ---------- selectie ----------
  function select(id, fly) {
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
  const numField = (h, key, label) => `<label class="field">${esc(label)}
      <input type="number" min="0" data-unit="${key}" value="${h.unit[key] ?? ""}">
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

    el.innerHTML = `
      <div class="fiche-head">
        <div class="row">
          <i class="dot ${h.status}" style="width:14px;height:14px"></i>
          <input class="fiche-title" data-field="name" value="${esc(h.name)}" aria-label="${esc(t("fiche.name"))}">
          <button class="icon-btn show-on-map" data-act="show-map" title="${esc(t("map.showOnMap"))}" aria-label="${esc(t("map.showOnMap"))}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg></button>
          <button class="icon-btn" data-act="close" title="${esc(t("btn.close"))}" aria-label="${esc(t("btn.close"))}">✕</button>
        </div>
        <div class="status-pick">
          ${STATUSES.map((k) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" title="${esc(t("status." + k))}"><i class="dot ${k}"></i>${esc(t("status." + k + ".short"))}</button>`).join("")}
        </div>
      </div>

      <div class="section">
        <div class="stats">
          <div class="stat"><b>${esc(fmtDate(lc))}</b><span>${esc(t("fiche.lastContact"))} ${lc ? "· " + esc(relDays(lc)) : ""}</span></div>
          <div class="stat"><b>${countType(h, "demo")}</b><span>${esc(t("fiche.demos"))}</span></div>
          <div class="stat"><b>${countType(h, "installation")}</b><span>${esc(t("fiche.installations"))}</span></div>
          <div class="stat"><b>${h.unit.roomsInstalled ?? "—"}</b><span>${esc(t("fiche.roomsLive"))}</span></div>
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("section.followup"))}</h3>
        <div class="grid">
          <label class="field">${esc(t("field.stage"))}
            <select data-field="stage">${STAGES.map((s) => opt(s, t("stage." + s), h.stage)).join("")}</select>
          </label>
          <label class="field">${esc(t("field.demoDate"))}
            <input type="date" data-field="demoDate" value="${esc(h.demoDate)}">
          </label>
          <label class="field">${esc(t("field.nextActionDate"))}
            <input type="date" data-field="nextActionDate" value="${esc(h.nextActionDate)}">
          </label>
          <label class="field full">${esc(t("field.nextAction"))} ${late ? `<span class="badge">${esc(t("badge.late"))}</span>` : ""}
            <input data-field="nextAction" value="${esc(h.nextAction)}" placeholder="${esc(t("field.nextAction.ph"))}">
          </label>
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("section.activities"))} <button class="btn small primary" data-act="add-activity">${esc(t("btn.addActivity"))}</button></h3>
        ${acts.length ? `<ul class="timeline">${acts.map((a) => {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const sub = [a.product, c && c.name, a.rooms ? `${a.rooms} ${t("act.rooms")}` : ""].filter(Boolean).join(" · ");
          return `<li>
            <div class="t-date">${esc(fmtDate(a.date))}</div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill" style="background:${ACT_TYPES[a.type] || "#999"}"></span>${esc(t("act." + a.type))}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${a.note ? `<div class="t-note">${esc(a.note)}</div>` : ""}
            </div>
            <div><button class="icon-btn" data-act="edit-activity" data-id="${a.id}" title="${esc(t("btn.edit"))}">✎</button></div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">${esc(t("empty.activities"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.contacts"))} <button class="btn small" data-act="add-contact">${esc(t("btn.addContact"))}</button></h3>
        ${contacts.length ? contacts.map((c) => `
          <div class="contact ${c.primary ? "primary" : ""}">
            <div class="c-actions">
              <button class="icon-btn" data-act="primary" data-id="${c.id}" title="${esc(t("dlg.c.primary"))}">${c.primary ? "★" : "☆"}</button>
              <button class="icon-btn" data-act="edit-contact" data-id="${c.id}" title="${esc(t("btn.edit"))}">✎</button>
            </div>
            <div class="c-name">${esc(c.name)}${c.primary ? `<span class="tag primary">${esc(t("tag.primary"))}</span>` : ""}${c.product ? `<span class="tag">${esc(c.product)}</span>` : ""}</div>
            ${c.role ? `<div class="c-role">${esc(c.role)}</div>` : ""}
            ${c.phone ? `<div class="c-line">☎ <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></div>` : ""}
            ${c.email ? `<div class="c-line">✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
            ${c.address ? `<div class="c-line muted">${esc(c.address)}</div>` : ""}
            ${c.notes ? `<div class="c-line muted">ⓘ ${esc(c.notes)}</div>` : ""}
          </div>`).join("") : `<p class="muted">${esc(t("empty.contacts"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("section.unit"))}</h3>
        <p class="muted">${esc(t("unit.unknownOk"))}</p>
        <div class="grid">
          <div class="field full"><span class="field-label">${esc(t("unit.scopeBrands"))}</span>
            <div class="toggles">${SCOPE_BRANDS.map((b) => `<label><input type="checkbox" data-scope="${esc(b)}" ${h.unit.scopeBrands.includes(b) ? "checked" : ""}>${esc(scopeLabel(b))}</label>`).join("")}</div>
          </div>
          <label class="field full">${esc(t("unit.scopeNotes"))}
            <input data-unit="scopeNotes" value="${esc(h.unit.scopeNotes)}" placeholder="${esc(t("unit.scopeNotes.ph"))}">
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
            <div class="toggles">${PRODUCTS.map((p) => `<label><input type="checkbox" data-product="${p}" ${h.products.includes(p) ? "checked" : ""}>${p}</label>`).join("")}</div>
          </div>
          <label class="field full">${esc(t("field.address"))}
            <input data-field="address" value="${esc(h.address)}">
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
      if (d.field === "stage") stageStatus(h);
    } else if (d.unit) {
      h.unit[d.unit] = el.type === "number" ? num(el.value) : el.value;
    } else if (d.unitBool) {
      h.unit[d.unitBool] = el.checked;
    } else if (d.scope) {
      h.unit.scopeBrands = el.checked
        ? [...new Set([...h.unit.scopeBrands, d.scope])]
        : h.unit.scopeBrands.filter((x) => x !== d.scope);
    } else if (d.product) {
      h.products = el.checked ? [...new Set([...h.products, d.product])] : h.products.filter((x) => x !== d.product);
    } else return;
    scheduleSave();
    renderList();
    renderKpis();
    if (["name", "nextActionDate", "demoDate", "stage", "country"].includes(d.field)) { renderFiche(); renderMarkers(); }
  });

  $("#fiche").addEventListener("click", (e) => {
    const h = sel();
    if (!h) return;
    const sb = e.target.closest("[data-status]");
    if (sb) { setStatus(h, sb.dataset.status); return; }
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

  function setStatus(h, status) {
    if (h.status === status) return;
    h.status = status;
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

    const close = () => { list.hidden = true; active = -1; };
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
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${I18N.lang === "nl" ? "nl" : "en"}&lat=${lat}&lon=${lon}`;
        let json = await (await fetch(`${url}&bbox=${REGION_BBOX.join(",")}`)).json();
        if (my !== seq) return;
        if (!json.features.length) json = await (await fetch(url)).json();
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
        if (my === seq) close();
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
    document.addEventListener("scroll", (e) => { if (!list.hidden && !list.contains(e.target)) close(); }, true);
    // mousedown i.p.v. click: anders verliest het veld eerst de focus en sluit de lijst.
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = e.target.closest("li[data-i]");
      if (li) pick(+li.dataset.i);
    });
  }

  // ---------- dialogen ----------
  function openDialog(html, onSubmit) {
    const dlg = $("#dialog");
    const form = $("#dialogForm");
    form.innerHTML = html;
    dlg.showModal();
    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    form.onsubmit = (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value === "cancel") return;
      if (submitter.value === "delete") { onSubmit(null, "delete"); return; }
      if (!form.reportValidity()) { e.preventDefault(); return; }
      onSubmit(Object.fromEntries(new FormData(form)), "ok");
    };
    return form;
  }

  function contactDialog(h, c) {
    const v = c || { name: "", role: "", phone: "", email: "", address: "", product: "", notes: "", primary: false };
    openDialog(`
      <h2>${esc(c ? t("dlg.contactEdit") : t("dlg.contactNew"))}</h2>
      <div class="grid">
        <label class="field full">${esc(t("dlg.c.name"))}<input name="name" required value="${esc(v.name)}"></label>
        <label class="field full">${esc(t("dlg.c.role"))}<input name="role" value="${esc(v.role)}" placeholder="${esc(t("dlg.c.role.ph"))}"></label>
        <label class="field">${esc(t("dlg.c.phone"))}<input name="phone" value="${esc(v.phone)}"></label>
        <label class="field">${esc(t("dlg.c.email"))}<input name="email" type="email" value="${esc(v.email)}"></label>
        <label class="field full">${esc(t("dlg.c.address"))}<input name="address" value="${esc(v.address)}"></label>
        <label class="field">${esc(t("dlg.c.product"))}
          <select name="product">${["", ...PRODUCTS].map((p) => opt(p, p || "—", v.product)).join("")}</select>
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
      } else {
        const rec = c || { id: uid() };
        Object.assign(rec, {
          name: data.name.trim(), role: data.role.trim(), phone: data.phone.trim(), email: data.email.trim(),
          address: data.address.trim(), product: data.product, notes: data.notes.trim(), primary: !!data.primary,
        });
        if (rec.primary) h.contacts.forEach((x) => { if (x !== rec) x.primary = false; });
        if (!c) h.contacts.push(rec);
        if (rec.product && !h.products.includes(rec.product)) h.products.push(rec.product);
      }
      scheduleSave();
      renderAll();
    });
  }

  function activityDialog(h, a) {
    const v = a || {
      date: today(),
      type: h.activities.length ? "email" : "prospecting",
      product: h.products.length === 1 ? h.products[0] : "",
      contactId: (h.contacts.find((c) => c.primary) || {}).id || "",
      rooms: "", note: "",
    };
    const form = openDialog(`
      <h2>${esc(a ? t("dlg.actEdit") : t("dlg.actNew"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("dlg.a.date"))}<input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field">${esc(t("dlg.a.type"))}
          <select name="type">${Object.keys(ACT_TYPES).map((k) => opt(k, t("act." + k), v.type)).join("")}</select>
        </label>
        <label class="field">${esc(t("dlg.a.product"))}
          <select name="product">${["", ...PRODUCTS].map((p) => opt(p, p || "—", v.product)).join("")}</select>
        </label>
        <label class="field">${esc(t("dlg.a.contact"))}
          <select name="contactId">${[opt("", "—", v.contactId), ...h.contacts.map((c) => opt(c.id, c.name, v.contactId))].join("")}</select>
        </label>
        <label class="field full" id="roomsField">${esc(t("dlg.a.rooms"))}<input type="number" min="0" name="rooms" value="${esc(v.rooms ?? "")}" placeholder="1"></label>
        <label class="field full">${esc(t("dlg.a.note"))}<textarea name="note" rows="4" placeholder="${esc(t("dlg.a.note.ph"))}">${esc(v.note)}</textarea></label>
      </div>
      <div class="actions">
        ${a ? `<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        if (!confirm(t("confirm.deleteActivity"))) return;
        h.activities = h.activities.filter((x) => x.id !== a.id);
      } else {
        const rec = a || { id: uid() };
        const wantsRooms = ROOM_TYPES.includes(data.type);
        Object.assign(rec, {
          date: data.date, type: data.type, product: data.product, contactId: data.contactId,
          rooms: wantsRooms ? num(data.rooms) : null, note: data.note.trim(),
        });
        if (!a) {
          h.activities.push(rec);
          autoStatus(h, rec);
        }
        // Een installatie of demo met aantal kamers werkt de afdelingsgegevens bij.
        if (rec.rooms) {
          if (rec.type === "installation") h.unit.roomsInstalled = rec.rooms;
          if (rec.type === "demo") h.unit.roomsDemo = rec.rooms;
        }
      }
      scheduleSave();
      renderAll();
    });
    const sync = () => {
      $("#roomsField", form).hidden = !ROOM_TYPES.includes(form.elements.type.value);
    };
    form.addEventListener("change", sync);
    sync();
  }

  // Verkoopfase bepaalt mee de kleur: Klant = groen, actieve fases = oranje.
  function stageStatus(h) {
    const before = h.status;
    if (h.stage === "customer") h.status = "green";
    else if (h.stage === "prospect") h.status = h.activities.length ? h.status : "red";
    else if (h.stage !== "not_interested" && h.status !== "green") h.status = "orange";
    if (h.status !== before) toast(h.status === "green" ? t("status.toGreen") : t("status.toOrange"));
  }

  // Kleur automatisch mee laten evolueren; manueel aanpassen blijft altijd mogelijk.
  function autoStatus(h, act) {
    if ((act.type === "installation" || act.type === "order") && h.status !== "green") {
      h.status = "green";
      if (PRE_SALE.includes(h.stage)) h.stage = "customer";
      toast(t("status.toGreen"));
    } else if (h.status === "red") {
      h.status = "orange";
      if (h.stage === "prospect") h.stage = "first_contact";
      toast(t("status.toOrange"));
    }
    if (act.type === "demo" && ["prospect", "first_contact", "meeting", "demo_planned"].includes(h.stage)) h.stage = "demo_installed";
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
        status: "red", stage: "prospect", products: [], nextAction: "", nextActionDate: "", demoDate: "",
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
  const csvCell = (v) => (typeof v === "number" ? String(v).replace(".", ",") : `"${String(v ?? "").replace(/"/g, '""')}"`);
  const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");

  $("#exportBtn").addEventListener("click", () => {
    openDialog(`
      <h2>${esc(t("dlg.export"))}</h2>
      <p class="muted">${esc(t("dlg.exportHint"))}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">${esc(t("export.hospitals"))}</button>
        <button class="btn" value="contacts">${esc(t("export.contacts"))}</button>
        <button class="btn" value="activities">${esc(t("export.activities"))}</button>
        <button class="btn" value="units">${esc(t("export.units"))}</button>
        <button class="btn" value="json">${esc(t("export.json"))}</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">${esc(t("btn.close"))}</button></div>`, () => {});
    $("#dialogForm").onsubmit = (e) => {
      const kind = e.submitter && e.submitter.value;
      const hs = state.db.hospitals;
      const d = today();
      const contactName = (h, id) => (h.contacts.find((c) => c.id === id) || {}).name;
      if (kind === "hospitals") {
        download(`hospitals-${d}.csv`, csv([
          [t("col.name"), t("col.country"), t("col.sector"), t("col.status"), t("col.stage"), t("col.products"),
            t("col.lastContact"), t("col.demos"), t("col.installations"), t("unit.roomsInstalled"),
            t("col.demoDate"), t("col.nextAction"), t("col.nextActionDate"), t("col.primaryContact"),
            t("col.address"), t("col.createdAt"), t("col.notes")],
          ...hs.map((h) => [h.name, h.country && t("country." + h.country), h.sector && t("sector." + h.sector),
            t("status." + h.status), t("stage." + h.stage), h.products.join(", "), lastContact(h),
            countType(h, "demo"), countType(h, "installation"), h.unit.roomsInstalled ?? "",
            h.demoDate, h.nextAction, h.nextActionDate, (h.contacts.find((c) => c.primary) || {}).name,
            h.address, h.createdAt, h.notes]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`contacts-${d}.csv`, csv([
          [t("col.hospital"), t("col.name"), t("col.role"), t("col.phone"), t("col.email"), t("col.address"), t("col.product"), t("col.isPrimary"), t("col.notes")],
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.role, c.phone, c.email, c.address, c.product, c.primary ? t("col.yes") : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`activities-${d}.csv`, csv([
          [t("col.date"), t("col.hospital"), t("col.type"), t("col.product"), t("col.contact"), t("col.rooms"), t("col.note")],
          ...hs.flatMap((h) => h.activities.map((a) => [a.date, h.name, t("act." + a.type), a.product, contactName(h, a.contactId), a.rooms ?? "", a.note]))
            .sort((a, b) => b[0].localeCompare(a[0])),
        ]), "text/csv");
      } else if (kind === "units") {
        download(`units-${d}.csv`, csv([
          [t("col.name"), t("col.country"), t("unit.scopeBrands"), t("unit.scopeNotes"), t("unit.rooms"),
            t("unit.roomsDemo"), t("unit.roomsInstalled"), t("unit.colosPerYear"), t("unit.existingAI"), t("unit.screening")],
          ...hs.map((h) => [h.name, h.country && t("country." + h.country), h.unit.scopeBrands.join(", "), h.unit.scopeNotes,
            h.unit.rooms ?? "", h.unit.roomsDemo ?? "", h.unit.roomsInstalled ?? "", h.unit.colosPerYear ?? "",
            h.unit.existingAI, h.unit.screening ? t("col.yes") : ""]),
        ]), "text/csv");
      } else if (kind === "json") {
        download(`followup-prion-backup-${d}.json`, JSON.stringify(state.db, null, 2), "application/json");
      }
    };
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
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

  // ---------- start ----------
  function renderAll() {
    if (!statsView.hidden) window.FollowUpStats.render(state.db, statsView, scheduleSave);
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
    try {
      await store.ready();
      const { db, empty } = await store.load();
      state.db = db;
      state.db.hospitals.forEach(normalize);
      $("#saveState").textContent = t("save.saved");
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
    $("#statsBtn").textContent = statsView.hidden ? t("btn.stats") : t("btn.backToMap");
    renderAll();
  });

  // ---------- schermen: lijst / kaart / statistieken ----------
  // Op desktop staan lijst en kaart naast elkaar; op gsm kies je via de tabbalk.
  const statsView = $("#statsView");
  function setView(view) {
    document.body.dataset.view = view;
    statsView.hidden = view !== "stats";
    $("#statsBtn").textContent = view === "stats" ? t("btn.backToMap") : t("btn.stats");
    document.querySelectorAll(".tabbar [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    try { localStorage.setItem("followup-view", view); } catch (e) { /* privévenster */ }
    if (view === "stats") window.FollowUpStats.render(state.db, statsView, scheduleSave);
    else window.FollowUpStats.hideTip();
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
    if (saved && saved !== "stats") setView(saved);
  } catch (e) { /* privévenster */ }

  // ---------- menu (⋯) ----------
  const menuList = $("#menuList");
  function toggleMenu(open) {
    menuList.hidden = !open;
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  }
  $("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(menuList.hidden); });
  menuList.addEventListener("click", () => toggleMenu(false));
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) toggleMenu(false); });
  init();
})();
