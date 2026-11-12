/* De toestemmingspagina voor de koppeling met een assistent (zie consent.html).
 *
 * Alles hier gaat met textContent en niet met innerHTML: de naam van de
 * aanvrager en het adres waar hij naartoe terug wil komen van buiten.
 */
(() => {
  "use strict";

  const cfg = window.FOLLOWUP_CONFIG || {};
  const I18N = window.FollowUpI18n;
  const t = I18N.t;
  const $ = (sel) => document.querySelector(sel);

  document.documentElement.lang = I18N.lang;
  I18N.applyStatic();

  const err = $("#consentError");
  const show = (el) => {
    document.querySelectorAll(".consent-step").forEach((x) => { x.hidden = x !== el; });
  };
  // canSwitch: er is een sessie, maar ermee verder gaan lukt niet (een
  // ingetrokken account, een verlopen sleutel). Dan moet je er nog uit kunnen,
  // anders zit je bij elke herlaadbeurt op dezelfde fout.
  const fail = (msg, canSwitch) => {
    show(null);
    err.textContent = msg;
    $("#consentOther").hidden = !canSwitch;
  };

  // Niet in een kader: een andere site zou de pagina onzichtbaar over een
  // eigen knop kunnen leggen. GitHub Pages stuurt geen kop mee die dat
  // verbiedt, dus weigeren we het hier zelf.
  if (window.top !== window.self) return fail(t("consent.framed"));

  const id = new URLSearchParams(location.search).get("authorization_id");
  if (!id) return fail(t("consent.missing"));
  // Zonder Supabase (de app draait op data/db.json) is er geen account om
  // toegang toe te geven.
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return fail(t("consent.noBackend"));

  // Zelfde project, dus dezelfde plek in localStorage als de app: wie daar al
  // aangemeld is, hoeft dat hier niet opnieuw te doen.
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const signOut = async (e) => {
    e.preventDefault();
    await client.auth.signOut({ scope: "local" });
    location.reload();
  };
  $("#consentSignOut").onclick = signOut;

  function signIn() {
    return new Promise((resolve) => {
      const form = $("#consentLogin");
      show(form);
      form.elements.email.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const btn = form.querySelector("button");
        btn.disabled = true;
        let error = null;
        try {
          ({ error } = await client.auth.signInWithPassword({
            email: form.elements.email.value.trim(),
            password: form.elements.password.value,
          }));
        } catch (e2) {
          error = e2;
        }
        btn.disabled = false;
        if (error) {
          err.textContent = t("login.failed") + (error.message === "Invalid login credentials" ? t("login.badCredentials") : error.message);
          return;
        }
        form.elements.password.value = "";
        resolve();
      };
    });
  }

  async function start() {
    const { data: s } = await client.auth.getSession();
    if (!s.session) await signIn();

    const { data, error } = await client.auth.oauth.getAuthorizationDetails(id);
    if (error || !data) return fail(t("consent.failed", { msg: (error && error.message) || "" }), true);
    // Geen authorization_id in het antwoord: deze aanvrager kreeg eerder al
    // toestemming, en Supabase geeft meteen het adres om naar terug te gaan.
    // We gaan er niet vanzelf heen. Op een gedeelde computer zou iemand anders
    // zo, zonder één scherm te zien, een assistent krijgen die werkt in naam
    // van wie hier nog aangemeld stond. Het scherm staat er dus altijd, en
    // verder gaan gebeurt alleen op een klik.
    const again = !data.authorization_id && !!data.redirect_url;

    const { data: u } = await client.auth.getUser();
    const email = (u && u.user && u.user.email) || "";
    const where = data.redirect_uri || "";
    $("#consentIntro").textContent = t("consent.intro", { client: (data.client && data.client.name) || t("consent.someone") });
    $("#consentWho").textContent = email ? t("consent.as", { name: email }) : "";
    $("#consentWhere").textContent = where ? t("consent.where", { url: where }) : "";
    $("#consentWhere").hidden = !where;
    show($("#consentAsk"));

    const buttons = (off) => { $("#consentApprove").disabled = $("#consentDeny").disabled = off; };
    const decide = async (approve) => {
      err.textContent = "";
      buttons(true);
      try {
        if (again) {
          // Eerder al toegestaan: toestaan is terugkeren naar de aanvrager,
          // weigeren is hier blijven. De code in dat adres verloopt vanzelf.
          if (approve) return location.assign(data.redirect_url);
          show(null);
          $("#consentDone").textContent = t("consent.denied");
          $("#consentDone").hidden = false;
          return;
        }
        // Allebei sturen ze de browser zelf terug naar de aanvrager.
        const res = approve
          ? await client.auth.oauth.approveAuthorization(id)
          : await client.auth.oauth.denyAuthorization(id);
        if (res.error) throw res.error;
      } catch (e) {
        buttons(false);
        err.textContent = t("consent.failed", { msg: (e && e.message) || "" });
      }
    };
    // Wie in deze browser al in de app was aangemeld, komt hier zonder
    // aanmeldformulier binnen. Dat is handig tot het de verkeerde account is:
    // de assistent zou dan in andermans naam werken. Afmelden en opnieuw
    // beginnen; de aanvraag in het adres blijft een tiental minuten geldig.
    $("#consentSwitch").onclick = signOut;
    $("#consentApprove").onclick = () => decide(true);
    $("#consentDeny").onclick = () => decide(false);
  }

  start().catch((e) => fail(t("consent.failed", { msg: e.message })));
})();
