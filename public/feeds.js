/* FollowUp Prion – agenda-abonnementen.
 *
 * Een adres dat een agenda-app (Outlook, Google, Apple) zelf ophaalt. Wat het
 * adres levert, maakt de databank (calendar_feed()) en
 * supabase/functions/calendar. Dit bestand is enkel wat je ervan ziet: de
 * dialoog "Abonneren" en de lijst van alle abonnementen op het
 * gebruikersscherm.
 *
 * Het weet niets van de toestand van app.js. Wat het daarvan nodig heeft
 * (een dialoog openen, een melding tonen) krijgt het één keer via init().
 *
 * Calendar subscriptions: the "Subscribe" dialog and the admin list on the
 * users screen. app.js passes in what it needs.
 */
window.FollowUpFeeds = (() => {
  "use strict";

  const I18N = window.FollowUpI18n;
  const t = (k, v) => I18N.t(k, v);
  const { esc, pickBox, syncPick, myProducts } = window.FollowUpDomain;
  const { icon, ask, tell } = window.FollowUpUI;

  // Van app.js, via init(): openDialog, KEEP_OPEN, toast, opt, $ en store.
  let app = null;
  const init = (deps) => { app = deps; };

  const feedDate = (ts) => (ts ? new Date(ts).toLocaleDateString(I18N.locale, { day: "numeric", month: "short", year: "numeric" }) : "");
  const feedSummary = (f) => [
    t(f.mine ? "feeds.mine" : "feeds.everyone"),
    f.products && f.products.length ? f.products.join(", ") : t("feeds.allProducts"),
    String(f.lang || "nl").toUpperCase(),
  ].join(" · ");
  // Eén abonnement in een lijst. button is de knop om het stop te zetten: in
  // de dialoog een verzendknop, op het gebruikersscherm een gewone knop.
  const feedRow = (f, owner, button) => `<div class="u-row feed-row">
      <div class="feed-what">
        <span><b>${esc(f.label || t("feeds.unnamed"))}</b>${owner ? ` <span class="muted">· ${esc(owner)}</span>` : ""}</span>
        <span class="muted">${esc(feedSummary(f))}</span>
        <span class="muted">${esc(t("feeds.created", { date: feedDate(f.created_at) }))} · ${
          esc(f.last_used ? t("feeds.used", { date: feedDate(f.last_used) }) : t("feeds.neverUsed"))}</span>
      </div>
      ${button}
    </div>`;

  // Abonneren: een adres dat je agenda-app zelf ophaalt. Twee toestanden in
  // dezelfde dialoog. Eerst de abonnementen die je al hebt en het formulier
  // voor een nieuw. Na het aanmaken maakt dat plaats voor het adres zelf, met
  // "Klaar" als enige knop: het adres is een sleutel die je maar één keer te
  // zien krijgt, dus er mag dan niets anders meer om aandacht vragen. Wie
  // sluit zonder te kopiëren, krijgt eerst de vraag of dat de bedoeling is.
  function dialog() {
    const { openDialog, KEEP_OPEN, toast, opt, $, store } = app;
    if (!store.feeds) return tell(t("feeds.localOnly"));
    const products = myProducts();
    // Een tweede klik terwijl de eerste nog onderweg is, maakt geen tweede adres.
    let busy = false;
    const keuzeHtml = () => `
      <h2>${esc(t("feeds.title"))}</h2>
      <p class="muted">${esc(t("feeds.intro"))}</p>
      <h3 class="feed-h">${esc(t("feeds.yours"))}</h3>
      <div class="feed-list"><p class="muted">${esc(t("feeds.loading"))}</p></div>
      <div class="feed-new">
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
      </div>
      <p class="muted feed-full" hidden>${esc(t("feeds.limit"))}</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.close"))}</button>
        <button class="btn primary" value="create">${esc(t("feeds.create"))}</button>
      </div>`;
    const adresHtml = (url) => {
      const webcal = url.replace(/^https:/, "webcal:");
      const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
      // Per agenda hoe je het toevoegt, dichtgeklapt: wie Outlook gebruikt,
      // hoeft de stappen voor Apple niet te lezen. name maakt er één groep
      // van, zodat er telkens één openstaat. Gewone <details>, geen .pick:
      // de luisteraar in domain.js laat ze dus met rust.
      return `
      <h2>${esc(t("feeds.readyTitle"))}</h2>
      <p class="muted">${esc(t("feeds.ready"))}</p>
      <div class="feed-url">
        <input readonly value="${esc(url)}" aria-label="${esc(t("feeds.address"))}">
        <button type="button" class="btn" data-feed-copy>${icon("copy")} ${esc(t("feeds.copy"))}</button>
      </div>
      <p class="feed-warn">${esc(t("feeds.secret"))}</p>
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
      </div>
      <div class="actions">
        <button class="btn primary" value="done">${esc(t("feeds.done"))}</button>
      </div>`;
    };
    // Zolang de databank het adres nog maakt, gaat de dialoog niet dicht: het
    // antwoord hoort in deze dialoog en nergens anders.
    const nietTerwijlBezig = () => {
      if (busy) toast(t("feeds.busy"));
      return Promise.resolve(!busy);
    };
    const form = openDialog(keuzeHtml(), (data, action) => {
      if (action === "create" && !busy) {
        busy = true;
        const chosen = [...form.querySelectorAll("[data-feed-product]:checked")].map((b) => b.dataset.feedProduct);
        store.feedCreate({ label: data.label.trim(), mine: data.mine === "1", products: chosen, lang: data.lang })
          .then((r) => toonAdres(store.feedUrl(r.secret)))
          .catch((e) => tell(t("feeds.failed", { msg: e.message })))
          .finally(() => { busy = false; });
      } else if (action.startsWith("remove:")) {
        const id = action.slice(7);
        ask(t("feeds.confirmRemove"), { ok: t("feeds.remove") }).then((yes) => yes && store.feedRemove(id)
          .then(() => { toast(t("feeds.removed")); return loadList(); })
          .catch((e) => tell(t("feeds.failed", { msg: e.message }))));
      }
      return KEEP_OPEN;
    }, null, { beforeClose: nietTerwijlBezig });
    // Enter in het naamveld maakt het adres. Anders nam de browser de eerste
    // knop van het formulier, en dat is "Stopzetten" bij het eerste abonnement.
    form.elements.label.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      $('[value="create"]', form).click();
    };
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
    // De tweede toestand. De databank bewaart enkel een hash: wie het adres
    // hier niet kopieert, maakt later een nieuw.
    function toonAdres(url) {
      let copied = false;
      // Een eigen dialoog, in dezelfde doos: "Klaar" sluit hem, en wie sluit
      // zonder te kopiëren krijgt eerst de vraag.
      openDialog(adresHtml(url), () => undefined, null, {
        beforeClose: () => (copied ? Promise.resolve(true) : ask(t("feeds.notCopied"), { ok: t("feeds.closeAnyway") })),
      });
      const input = $(".feed-url input", form);
      $("[data-feed-copy]", form).onclick = () => {
        input.select();
        const gelukt = () => { copied = true; toast(t("feeds.copied")); };
        const mislukt = () => toast(t("feeds.copyFailed"));
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(gelukt, () => (document.execCommand("copy") ? gelukt() : mislukt()));
        else if (document.execCommand("copy")) gelukt(); else mislukt();
      };
      input.focus();
      input.select();
    }
    function loadList() {
      const list = $(".feed-list", form);
      if (!list) return Promise.resolve();
      return store.feedList().then(({ feeds, max }) => {
        // Bij het maximum geen formulier dat pas na een klik zegt dat het niet
        // kan: dan staat er meteen dat je er eerst een moet stopzetten. Het
        // maximum komt van de databank (feed_max() in schema.sql); kent die
        // het nog niet, dan blijft het formulier staan en weigert feed_create.
        const vol = max != null && feeds.length >= max;
        $(".feed-new", form).hidden = vol;
        $(".feed-full", form).hidden = !vol;
        $('[value="create"]', form).hidden = vol;
        list.innerHTML = feeds.length ? `<div class="u-list">${feeds.map((f) => feedRow(f, "",
          `<button class="btn small danger" value="remove:${esc(f.id)}" formnovalidate>${esc(t("feeds.remove"))}</button>`)).join("")}</div>`
          : `<p class="muted">${esc(t("feeds.none"))}</p>`;
      }, (e) => { list.innerHTML = `<p class="feed-error">${esc(t("feeds.failed", { msg: e.message }))}</p>`; });
    }
    loadList();
  }

  // Elk abonnement van iedereen, voor een beheerder: wie welk adres heeft en
  // of een agenda het nog ophaalt. Stopzetten maakt het adres meteen
  // ongeldig; het abonnement zelf zien of overnemen kan niet, het geheim
  // staat nergens. box is de plek op het gebruikersscherm; dat scherm tekent
  // zich opnieuw, dus de knoppen hangen aan box en niet aan het scherm.
  function allInto(box) {
    const { toast, store } = app;
    if (!box) return;
    box.onclick = async (e) => {
      const b = e.target.closest("[data-feed-remove]");
      if (!b || !(await ask(t("feeds.confirmRemoveOther"), { ok: t("feeds.remove") }))) return;
      try {
        await store.feedRemove(b.dataset.feedRemove);
        toast(t("feeds.removed"));
      } catch (err) {
        tell(t("feeds.failed", { msg: err.message }));
      }
      allInto(box);
    };
    store.feedList(true).then(({ feeds }) => {
      box.innerHTML = feeds.length ? `<div class="u-list">${feeds.map((f) => feedRow(f, f.owner_name || "?",
        `<button type="button" class="btn small danger" data-feed-remove="${esc(f.id)}">${esc(t("feeds.remove"))}</button>`)).join("")}</div>`
        : `<p class="muted">${esc(t("feeds.noneAll"))}</p>`;
    }, (e) => { box.innerHTML = `<p class="feed-error">${esc(t("feeds.failed", { msg: e.message }))}</p>`; });
  }

  return { init, dialog, allInto };
})();
