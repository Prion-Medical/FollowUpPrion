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
  const fail = (msg) => { show(null); err.textContent = msg; };

  const id = new URLSearchParams(location.search).get("authorization_id");
  if (!id) return fail(t("consent.missing"));
  // Zonder Supabase (de app draait op data/db.json) is er geen account om
  // toegang toe te geven.
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return fail(t("consent.noBackend"));

  // Zelfde project, dus dezelfde plek in localStorage als de app: wie daar al
  // aangemeld is, hoeft dat hier niet opnieuw te doen.
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

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
    if (error || !data) return fail(t("consent.failed", { msg: (error && error.message) || "" }));
    // Geen authorization_id in het antwoord: deze aanvrager kreeg eerder al
    // toestemming, en Supabase geeft meteen het adres om naar terug te gaan.
    if (!data.authorization_id && data.redirect_url) return location.assign(data.redirect_url);

    const { data: u } = await client.auth.getUser();
    $("#consentIntro").textContent = t("consent.intro", { client: (data.client && data.client.name) || "?" });
    $("#consentWho").textContent = t("consent.as", { name: (u && u.user && u.user.email) || "" });
    $("#consentWhere").textContent = t("consent.where", { url: data.redirect_uri || "" });
    show($("#consentAsk"));

    const decide = async (approve) => {
      err.textContent = "";
      $("#consentApprove").disabled = $("#consentDeny").disabled = true;
      // Allebei sturen ze de browser zelf terug naar de aanvrager.
      const res = approve
        ? await client.auth.oauth.approveAuthorization(id)
        : await client.auth.oauth.denyAuthorization(id);
      if (res.error) {
        $("#consentApprove").disabled = $("#consentDeny").disabled = false;
        err.textContent = t("consent.failed", { msg: res.error.message });
      }
    };
    // Wie in deze browser al in de app was aangemeld, komt hier zonder
    // aanmeldformulier binnen. Dat is handig tot het de verkeerde account is:
    // de assistent zou dan in andermans naam werken. Afmelden en opnieuw
    // beginnen; de aanvraag in het adres blijft een tiental minuten geldig.
    $("#consentSwitch").onclick = async (e) => {
      e.preventDefault();
      await client.auth.signOut({ scope: "local" });
      location.reload();
    };
    $("#consentApprove").onclick = () => decide(true);
    $("#consentDeny").onclick = () => decide(false);
  }

  start().catch((e) => fail(t("consent.failed", { msg: e.message })));
})();
