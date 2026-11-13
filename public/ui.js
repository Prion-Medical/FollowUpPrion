/* FollowUp Prion — wat de pagina dóet, los van wat de app wéét.
 *
 * domain.js houdt de vaste waarden en het rekenwerk bij en moet ook buiten een
 * browser in te lezen blijven. Alles wat de pagina aanraakt zonder iets van
 * ziekenhuizen te weten staat daarom hier: pictogrammen, iets laten
 * verdwijnen, de eigen vraag-dialoog, rijen die naar hun plek glijden, de
 * schakelaar met het glijdende plaatje en de zelf getekende keuzelijst.
 * app.js gebruikt dit; niets hier kent app.js.
 */
window.FollowUpUI = (() => {
  "use strict";
  const { esc, STATUSES } = window.FollowUpDomain;
  const t = (k, v) => window.FollowUpI18n.t(k, v);

  // ---------- beweging ----------
  // Eén uitloop voor alles wat JavaScript in beweging zet; dezelfde als --ease
  // in styles.css. En één plaats die weet of beweging gewenst is.
  const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = () => window.matchMedia("(max-width: 760px)").matches;

  // Iets laten verdwijnen: kort uitfaden (en eventueel wegschuiven), en dán
  // pas doen wat het echt weghaalt — hidden zetten, sluiten, uit de pagina
  // halen. Dat is `after`. Eén manier voor de fiche, het menu, de melding, de
  // dialogen en de uitklaplijsten, in elke browser dezelfde.
  //
  // Een klok en geen "animatie klaar": dat signaal komt pas met het volgende
  // beeld, en in een venster dat niet getekend wordt dus nooit. fill: forwards
  // houdt het element onzichtbaar tot `after` gelopen is; daarna wordt de
  // animatie weggehaald, anders ging het de volgende keer onzichtbaar open.
  const going = new WeakMap();
  const leaving = (el) => going.has(el);
  // Bedacht: het moet toch blijven (opnieuw geopend terwijl het wegging).
  function stay(el) {
    const g = going.get(el);
    if (!g) return;
    clearTimeout(g.timer);
    for (const a of g.anims) a.cancel();
    going.delete(el);
  }
  function leave(el, after, { ms = 130, shift = "", backdrop = false } = {}) {
    if (leaving(el)) return;
    if (calm() || !el.animate) return after();
    const o = { duration: ms, easing: EASE, fill: "forwards" };
    // Alleen het eindbeeld: zo vertrekt het van waar het nu staat, ook als het
    // zelf al een transform draagt (de melding hangt op -50%).
    const anims = [el.animate([shift ? { opacity: 0, transform: shift } : { opacity: 0 }], o)];
    if (backdrop) anims.push(el.animate([{ opacity: 0 }], { ...o, pseudoElement: "::backdrop" }));
    const timer = setTimeout(() => {
      going.delete(el);
      after();
      for (const a of anims) a.cancel();
    }, ms);
    going.set(el, { timer, anims });
  }

  // ---------- pictogrammen ----------
  // Op één plaats en als SVG. Vroeger stonden hier tekens uit het lettertype
  // (✎ ✓ ★ ☎): die zien er op elk toestel anders uit, lijnen nergens mee uit
  // en kleuren niet mee in de donkere weergave. Dit is onze eigen opmaak en
  // geen invoer van een gebruiker, dus hier hoeft geen esc().
  const ICONS = {
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8L12 3.5Z"/>',
    phone: '<path d="M5 4h4l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2L20 15v4a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    note: '<path d="M5 4h14v11l-5 5H5V4Z"/><path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    prev: '<path d="m14.5 6-6 6 6 6"/>',
    next: '<path d="m9.5 6 6 6-6 6"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  };
  const icon = (name, cls) =>
    `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  // ---------- dialogen ----------
  // Een dialoog die zacht dichtgaat. De browser sluit een <dialog> in één
  // klap; hier faden hij en het waas erachter eerst uit terwijl hij nog
  // openstaat. De belofte komt uit zodra hij echt dicht is, met de waarde
  // waarmee hij sloot — niet via het close-event, zie leave().
  function softClose(dlg, value = "") {
    return new Promise((resolve) => {
      if (!dlg.open || leaving(dlg)) return resolve(value);
      leave(dlg, () => { dlg.close(value); resolve(value); },
        { shift: phone() ? "translateY(24px)" : "translateY(6px) scale(0.98)", backdrop: true });
    });
  }
  // Een vraag of een melding in een eigen dialoog, in plaats van de grijze
  // doos van de browser. ask() belooft true of false; Escape en "Annuleer"
  // zijn allebei nee. De focus begint op de veilige knop, zodat een Enter te
  // veel niets weggooit. tell() is dezelfde doos met één knop.
  function ask(msg, { ok = t("btn.delete"), danger = true, cancel = true } = {}) {
    return new Promise((resolve) => {
      const d = document.getElementById("ask");
      d.innerHTML = `<form method="dialog">
        <p class="ask-msg">${esc(msg)}</p>
        <div class="actions">
          ${cancel ? `<button class="btn" value="cancel">${esc(t("btn.cancel"))}</button>` : ""}
          <button class="btn ${danger ? "danger solid" : "primary"}" value="ok">${esc(ok)}</button>
        </div></form>`;
      const answer = (value) => softClose(d, value).then((v) => resolve(v === "ok"));
      d.onsubmit = (e) => { e.preventDefault(); answer(e.submitter ? e.submitter.value : ""); };
      d.oncancel = (e) => { e.preventDefault(); answer(""); }; // Escape
      d.showModal();
      d.querySelector(cancel ? '[value="cancel"]' : '[value="ok"]').focus();
    });
  }
  const tell = (msg) => ask(msg, { ok: t("btn.close"), danger: false, cancel: false });

  // ---------- rijen die naar hun plek glijden ----------
  // Na een filter of een zoekterm staat een lijst er in één klap anders: rijen
  // weg, andere ertussen, alles verspringt. Dat leest als een schok. In twee
  // stappen rond het hertekenen: rowTops() meet vooraf waar elke rij staat,
  // settleRows() laat achteraf een rij die blijft naar haar nieuwe plek
  // schuiven en een nieuwe zacht opkomen. Rijen die verdwijnen, verdwijnen
  // gewoon: wachten tot ze uitgefaded zijn zou het typen vertragen.
  //
  // Wat een rij is en hoe ze heet, zegt de oproeper met een selector en een
  // sleutel. Kort en klein, want dit gebeurt bij elke toetsaanslag: de afstand
  // is afgetopt, zodat een rij van ver niet het hele scherm oversteekt. Alleen
  // transform en opacity, via element.animate(): dat kan de browser buiten de
  // hoofddraad afspelen. `bottom` begrenst het meten: wat daaronder staat ziet
  // niemand bewegen.
  const ROW_MOVE = { duration: 340, easing: EASE };
  function rowTops(root, sel, key, bottom = Infinity) {
    const tops = new Map();
    for (const el of root.querySelectorAll(sel)) {
      const top = el.getBoundingClientRect().top;
      if (top > bottom) break;
      tops.set(key(el), top);
    }
    return tops;
  }
  function settleRows(root, sel, key, before, bottom) {
    if (calm() || !root.animate) return;
    // Eerst alles meten, dan pas iets in beweging zetten. Door elkaar zou elke
    // meting de browser dwingen de stijl van de rij ervoor opnieuw uit te
    // rekenen.
    const now = rowTops(root, sel, (el) => el, bottom);
    for (const [el, top] of now) {
      const was = before.get(key(el));
      if (was === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], ROW_MOVE);
      } else if (Math.abs(was - top) > 1) {
        const d = Math.max(-64, Math.min(64, was - top));
        el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], ROW_MOVE);
      }
    }
  }

  // ---------- de schakelaar die glijdt ----------
  // Een schakelaar (Gepland | Logboek, Abonnementen | Installaties, licht |
  // donker, en de drie statusknoppen in de fiche) toont de gekozen knop met
  // een plaatje om het woord. Dat plaatje glijdt hier van de oude naar de
  // nieuwe keuze. Twee dingen maken het lastiger dan het lijkt:
  //
  // - De schermen bouwen hun innerHTML opnieuw op bij elke klik, dus de knop
  //   waar het plaatje vandaan komt bestaat daarna niet meer. Daarom meten we
  //   in de capture-fase, vóór de pagina reageert, waar het plaatje nu staat,
  //   en zetten we het in het volgende beeld op die plek terug in de verse
  //   schakelaar. Vandaar ook de sleutel: de schakelaar is een andere node.
  // - Wie halverwege terugklikt, moet het plaatje zien omkeren. De gemeten
  //   plek is dan die van het plaatje onderweg, en een transition vertrekt
  //   altijd van waar iets op dat moment is.
  //
  // De beweging zelf is een CSS-transition op transform (zie .seg-pill in
  // styles.css); JavaScript zet alleen het begin en het einde klaar, één keer
  // per klik. Het zijn twee plaatjes, een vlug en een traag: samen één vlak
  // dat uitrekt terwijl het onderweg is.
  //
  // Een statusknop kleurt per keuze. Het plaatje neemt de kleur van de knop
  // waar het vandaan komt en krijgt die van de knop waar het heen gaat; de
  // overgang ertussen doet styles.css. Welke kleuren er zijn, weet STATUSES.
  const SEGS = ".s-seg, .status-pick";
  const segTone = (el) => STATUSES.find((c) => el.classList.contains(c)) || "";
  const segKey = (seg) => {
    // Vanaf de ouder: draagt de schakelaar zelf een id, dan zou hij zichzelf
    // als gastheer vinden en er niet in voorkomen.
    const host = seg.parentElement && seg.parentElement.closest("[id]");
    return (host ? host.id : "") + "#" + [...(host || document).querySelectorAll(SEGS)].indexOf(seg);
  };
  const segFind = (key) => {
    const [id, i] = key.split("#");
    const host = id ? document.getElementById(id) : document;
    return host ? host.querySelectorAll(SEGS)[+i] || null : null;
  };
  // Plaats en maat ten opzichte van de schakelaar zelf.
  const segBox = (el, seg) => {
    const a = el.getBoundingClientRect(), b = seg.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  };
  // Het plaatje zit om het woord, niet om de hele knop: de span erin. De knop
  // eromheen is het klikvlak en laat ruimte om in door te veren.
  const segMark = (btn) => btn.querySelector("span") || btn;
  const segPill = (lag, tone, box, to) => {
    const p = document.createElement("i");
    p.className = ["seg-pill", lag && "lag", tone].filter(Boolean).join(" ");
    p.setAttribute("aria-hidden", "true");
    // Maat en hoogte zijn meteen die van de nieuwe knop; alleen de plaats beweegt.
    Object.assign(p.style, { width: to.w + "px", height: to.h + "px", top: to.y + "px", transition: "none", transform: `translateX(${box.x}px)` });
    return p;
  };
  function segSlide(e) {
    const btn = e.target.closest && e.target.closest(".s-seg button, .status-pick button");
    if (!btn || btn.classList.contains("active") || calm()) return;
    const seg = btn.parentElement;
    // Waar staat het plaatje nu, en in welke kleur? Onderweg: de plaatjes
    // zelf. In rust: de knop die aan stond. Staat er niets aan, dan valt er
    // niets te glijden.
    const pills = [...seg.querySelectorAll(".seg-pill")];
    const was = seg.querySelector("button.active");
    if (!pills.length && !was) return;
    const lead = pills.find((p) => !p.classList.contains("lag")), lag = pills.find((p) => p.classList.contains("lag"));
    const from = pills.length ? [segBox(lead, seg), segBox(lag, seg)] : [segBox(segMark(was), seg), segBox(segMark(was), seg)];
    const toneWas = pills.length ? segTone(lead) : segTone(was);
    const key = segKey(seg);
    requestAnimationFrame(() => {
      const now = segFind(key);
      const on = now && now.querySelector("button.active");
      if (!on) return;
      const to = segBox(segMark(on), now), tone = segTone(on);
      for (const p of now.querySelectorAll(".seg-pill")) p.remove();
      // Het vlugge plaatje ligt bovenop: het trage gaat er eerst in.
      const slow = segPill(true, toneWas, from[1], to), fast = segPill(false, toneWas, from[0], to);
      now.prepend(slow, fast);
      now.classList.add("seg-live");
      // Eén keer de opmaak laten uitrekenen, zodat de browser de beginplek
      // kent; daarna pas de transition aan en het doel erin.
      void now.offsetWidth;
      for (const p of [slow, fast]) {
        p.style.transition = "";
        p.style.transform = `translateX(${to.x}px)`;
        if (toneWas) p.classList.remove(toneWas);
        if (tone) p.classList.add(tone);
      }
      // Het trage plaatje komt als laatste aan. Dan ruimen we op en draagt de
      // knop zelf weer zijn achtergrond: zo klopt de plek ook nog nadat het
      // venster van grootte verandert. De kleur is eerder klaar dan de
      // beweging; wachten op de beweging.
      slow.addEventListener("transitionend", (ev) => {
        if (ev.propertyName !== "transform" || !slow.isConnected) return;
        slow.remove();
        fast.remove();
        now.classList.remove("seg-live");
      });
    });
  }
  document.addEventListener("click", segSlide, true);

  // ---------- keuzelijsten ----------
  // De lijst van een <select>, zelf getekend. De reden staat bij .sel-list in
  // styles.css: de lijst van het systeem valt over het veld heen, en hoe dat
  // eruitziet verschilt per browser. Dit werkt overal hetzelfde.
  //
  // De <select> zelf blijft wat hij is. Wij houden alleen zijn eigen lijst
  // tegen (preventDefault op mousedown) en tonen de onze; bij een keuze zetten
  // we zijn waarde en sturen we een gewone change. Wie naar change luistert of
  // het formulier uitleest, ziet dus geen verschil, en een select die een
  // scherm er later bijzet doet vanzelf mee: er wordt niets per stuk omgebouwd.
  //
  // Alleen met een muis. Op een aanraakscherm is het keuzewiel van het toestel
  // beter dan wat wij kunnen tekenen, en dat valt ook niet over het veld.
  let sel = null; // { el, list, i } zolang er een lijst openstaat
  const selFine = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const selOk = (el) => el && el.tagName === "SELECT" && !el.multiple && !el.disabled && selFine();
  const selClose = () => {
    if (!sel) return;
    const { el, list } = sel;
    sel = null;
    el.classList.remove("sel-open");
    // De lijst reageert nergens meer op terwijl ze wegfadet.
    list.style.pointerEvents = "none";
    leave(list, () => list.remove(), { ms: 90 });
  };
  // De regel waar je op staat (muis of pijltjes), en zorgen dat ze in beeld is.
  const selMark = (i, scroll) => {
    if (!sel || i < 0 || i >= sel.el.options.length) return;
    sel.i = i;
    [...sel.list.children].forEach((o, k) => o.classList.toggle("on", k === i));
    if (scroll) sel.list.children[i].scrollIntoView({ block: "nearest" });
  };
  // Eén stap verder in de gegeven richting, over uitgeschakelde regels heen.
  const selStep = (from, by) => {
    const opts = sel.el.options;
    for (let i = from + by; i >= 0 && i < opts.length; i += by) if (!opts[i].disabled) return i;
    return from;
  };
  const selPick = (i) => {
    const el = sel.el, o = el.options[i];
    if (!o || o.disabled) return;
    selClose();
    if (el.selectedIndex !== i) {
      el.selectedIndex = i;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Het scherm kan zich net opnieuw getekend hebben; dan is dit veld weg.
    if (el.isConnected) el.focus();
  };
  const selShow = (el) => {
    selClose();
    const list = document.createElement("div");
    list.className = "sel-list";
    list.setAttribute("role", "listbox");
    [...el.options].forEach((o, i) => {
      const row = document.createElement("div");
      row.className = "sel-opt" + (o.selected ? " checked" : "") + (o.disabled ? " off" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(o.selected));
      row.dataset.i = i;
      row.textContent = o.textContent; // textContent, dus hier hoeft geen esc()
      list.append(row);
    });
    // In een dialoog moet de lijst ín de dialoog hangen: die ligt in de
    // bovenste laag van de browser, en al wat daarbuiten staat valt eronder.
    (el.closest("dialog") || document.body).append(list);
    // Onder het veld als ze daar past of als daar de meeste plaats is, anders
    // erboven. Nooit erover.
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const down = list.offsetHeight <= below || below >= above;
    list.style.minWidth = r.width + "px";
    list.style.maxHeight = Math.max(120, down ? below : above) + "px";
    if (down) list.style.top = r.bottom + 4 + "px";
    else list.style.bottom = window.innerHeight - r.top + 4 + "px";
    list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - list.offsetWidth - 8)) + "px";
    list.style.transformOrigin = down ? "top left" : "bottom left";
    // Een klik in de lijst mag de focus niet van het veld halen.
    list.addEventListener("mousedown", (e) => e.preventDefault());
    list.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".sel-opt");
      if (row && sel && +row.dataset.i !== sel.i) selMark(+row.dataset.i, false);
    });
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".sel-opt");
      if (row && sel) selPick(+row.dataset.i);
    });
    el.classList.add("sel-open");
    sel = { el, list, i: -1 };
    selMark(el.selectedIndex, true);
  };
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (sel && sel.list.contains(e.target)) return;
    const el = e.target.closest && e.target.closest("select");
    const was = sel && sel.el;
    selClose();
    if (!selOk(el)) return;
    // Dit houdt de lijst van het systeem tegen. De focus zetten we zelf, want
    // die hoort bij dezelfde standaardactie en gaat dus mee verloren.
    e.preventDefault();
    el.focus();
    if (el !== was) selShow(el); // nog eens klikken op hetzelfde veld sluit
  }, true);
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if (!selOk(el)) return;
    const open = sel && sel.el === el;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (!open) {
      // Spatie en Alt+pijl openen, zoals bij een gewone select. De pijltjes
      // alleen blijven van de browser: die bladeren door de waarden.
      if (e.key === " " || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) { stop(); selShow(el); }
      return;
    }
    if (e.key === "Escape") { stop(); selClose(); } // en níet ook de dialoog eronder
    else if (e.key === "Tab") selClose();
    else if (e.key === "Enter" || e.key === " ") { stop(); selPick(sel.i); }
    else if (e.key === "ArrowDown") { stop(); selMark(selStep(sel.i, 1), true); }
    else if (e.key === "ArrowUp") { stop(); selMark(selStep(sel.i, -1), true); }
    else if (e.key === "Home") { stop(); selMark(selStep(-1, 1), true); }
    else if (e.key === "End") { stop(); selMark(selStep(el.options.length, -1), true); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Een letter: naar de volgende regel die ermee begint.
      stop();
      const n = el.options.length, c = e.key.toLowerCase();
      for (let k = 1; k <= n; k++) {
        const i = (sel.i + k) % n;
        if (!el.options[i].disabled && el.options[i].textContent.trim().toLowerCase().startsWith(c)) { selMark(i, true); break; }
      }
    }
  }, true);
  // Verschuift de pagina onder de lijst, dan klopt haar plek niet meer.
  document.addEventListener("scroll", (e) => { if (sel && e.target !== sel.list) selClose(); }, true);
  window.addEventListener("resize", selClose);
  document.addEventListener("focusout", (e) => { if (sel && e.target === sel.el) selClose(); });

  return { icon, leave, stay, leaving, softClose, ask, tell, rowTops, settleRows };
})();
