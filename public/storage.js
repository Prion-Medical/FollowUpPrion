/* FollowUp Prion – opslag / storage.
 * Zonder Supabase-gegevens in config.js: lokale server (server.py, /api/data).
 * Met Supabase-gegevens: online databank met login. */
window.FollowUpStore = (() => {
  "use strict";
  const cfg = window.FOLLOWUP_CONFIG || {};
  const t = (k) => window.FollowUpI18n.t(k);
  const $ = (sel) => document.querySelector(sel);

  class ConflictError extends Error {}

  // write_state() geeft bij een weigering een sleutel mee in hint. Die vertalen
  // we hier naar een melding; de SQL-tekst zelf is voor ons, niet voor de
  // gebruiker. Een onbekende sleutel valt terug op de ruwe melding, zodat er
  // nooit stilletjes niets gebeurt.
  const MELDINGEN = {
    readonly: "rights.readOnly",
    no_delete: "rights.noDelete",
    no_import: "rights.noImport",
    out_of_scope: "rights.outOfScope",
    invalid_payload: "rights.badPayload",
    duplicate_id: "rights.badPayload",
    empty_payload: "rights.badPayload",
    too_many_deletes: "rights.tooManyDeletes",
  };

  // Wat elke rol mag. Eén tabel, zodat app.js en stats.js nergens zelf rollen
  // moeten vergelijken: die lezen alleen store.can.
  //
  // Alle vier worden ook door de databank afgedwongen (zie supabase/schema.sql).
  // write_state() neemt een inventaris van elk id vóór en ná het samenvoegen en
  // ziet daarmee dat er iets binnen in het document verdween — dat is wat
  // "niet verwijderen" echt maakt. Deze tabel is het vangnet ervoor: ze kan het
  // meteen zeggen in plaats van na een mislukte opslag.
  const RIGHTS = {
    admin: { write: true, remove: true, importData: true, manageUsers: true },
    editor: { write: true, remove: true, importData: true, manageUsers: false },
    contributor: { write: true, remove: false, importData: false, manageUsers: false },
    viewer: { write: false, remove: false, importData: false, manageUsers: false },
  };

  // Wie er aangemeld is en wat die mag. Vóór ready() weet de app dit nog niet,
  // en tot dan geldt het krapste recht: liever een knop die te laat verschijnt
  // dan een knop die te vroeg werkt.
  let me = { id: "", name: "", role: "viewer", products: [] };
  // noProfile: we konden niet te weten komen wat deze gebruiker mag. Dan valt
  // alles terug op viewer — de veilige kant — maar dat ziet er van buiten uit
  // als "ik mag plots niets meer". Daarom zegt de app het met zoveel woorden.
  const can = { ...RIGHTS.viewer, products: [], noProfile: false };
  function setMe(u) {
    me = { id: u.id || "", name: u.name || "", role: RIGHTS[u.role] ? u.role : "viewer", products: Array.isArray(u.products) ? u.products : [] };
    Object.assign(can, RIGHTS[me.role], { products: me.products });
    // Importeren kan niet met een productbeperking: wie maar een deel van het
    // document ziet, zou met een volledige back-up alles wissen wat hij niet
    // zag. write_state() weigert het ook — dit houdt de knop meteen weg.
    can.importData = can.importData && me.products.length === 0;
  }

  const local = {
    mode: "local",
    ConflictError,
    can,
    me: () => me,
    async ready() {
      // Lokaal is er geen login: één gebruiker aan zijn eigen computer, en die
      // mag alles. Een naam is er alleen als config.js er een meegeeft; anders
      // blijft de stempel bij een contactmoment leeg, wat eerlijker is dan een
      // verzonnen naam.
      // Een vast id, zodat de naam uit config.js ook bij je contactmomenten
      // komt te staan. Geen naam ingesteld? Dan ook geen id, en blijft de
      // stempel leeg in plaats van "local" te tonen.
      setMe({ id: cfg.localUser ? "local" : "", name: cfg.localUser, role: "admin", products: [] });
      // Er is hier niemand om te beheren.
      can.manageUsers = false;
    },
    async users() { return []; },
    async saveUser() { throw new Error(t("users.localOnly")); },
    async load() {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(t("store.localFail"));
      return { db: await res.json(), empty: false };
    },
    async save(db) {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(db),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
    },
    async signOut() {},
  };

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return local;

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  let lastUpdated = null; // versie die we laatst gelezen/geschreven hebben

  function showLogin() {
    return new Promise((resolve) => {
      const box = $("#login");
      const form = $("#loginForm");
      const err = $("#loginError");
      box.hidden = false;
      form.elements.email.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const btn = form.querySelector("button");
        btn.disabled = true;
        // Zeg dat er iets gebeurt: op een trage verbinding leek een uitgegrijsde
        // knop op een klik die niet was aangekomen. Het draaiende rondje tekent
        // styles.css op .busy.
        const label = btn.textContent;
        btn.textContent = t("login.busy");
        btn.classList.add("busy");
        let error = null;
        try {
          ({ error } = await client.auth.signInWithPassword({
            email: form.elements.email.value.trim(),
            password: form.elements.password.value,
          }));
        } catch (e) {
          // Geen netwerk of databank onbereikbaar: zonder deze vangnet blijft
          // de knop uit staan en kan je alleen nog herladen.
          error = e;
        }
        btn.disabled = false;
        btn.classList.remove("busy");
        btn.textContent = label;
        if (error) {
          err.textContent = t("login.failed") + (error.message === "Invalid login credentials" ? t("login.badCredentials") : error.message);
          return;
        }
        form.elements.password.value = "";
        box.hidden = true;
        resolve();
      };
    });
  }

  // Rol en bereik ophalen. Staat er geen rij in app_users — het schema is nog
  // niet uitgevoerd, of de trigger die er een aanmaakt heeft niet gelopen — dan
  // blijft het bij viewer. Lezen mag dan nog, schrijven niet, en dat is de
  // juiste kant om op te vallen.
  async function loadMe() {
    const { data: s } = await client.auth.getSession();
    const user = s.session && s.session.user;
    if (!user) return;
    const { data, error } = await client.from("app_users").select("name, role, products").eq("id", user.id).maybeSingle();
    // Geen tabel (schema.sql nog niet uitgevoerd) of geen rij (de trigger heeft
    // niet gelopen): allebei eindigt het op viewer, en allebei is het iets om
    // recht te zetten in plaats van stil te ondergaan.
    can.noProfile = !!error || !data;
    setMe({
      id: user.id,
      // Zonder naam in app_users valt het e-mailadres in: beter dat naast een
      // contactmoment dan niets.
      name: (data && data.name) || user.email || "",
      role: data && data.role,
      products: data && data.products,
    });
  }

  return {
    mode: "supabase",
    ConflictError,
    can,
    me: () => me,
    async ready() {
      const { data } = await client.auth.getSession();
      if (!data.session) await showLogin();
      await loadMe();
    },
    // De hele lijst, voor het beheerscherm en om een naam bij een contactmoment
    // te kunnen zetten. Elke aangemelde gebruiker mag die lezen.
    async users() {
      const { data, error } = await client.from("app_users").select("id, name, role, products").order("name");
      if (error) throw new Error(error.message);
      return data || [];
    },
    // Enkel een beheerder komt hier door; de rij-beveiliging weigert de rest.
    // De rij bestaat altijd al — ze wordt aangemaakt zodra de gebruiker in het
    // Supabase-dashboard verschijnt — dus dit is een update, geen upsert.
    async saveUser(u) {
      const { data, error } = await client.from("app_users")
        .update({ name: u.name, role: u.role, products: u.products })
        .eq("id", u.id).select("id");
      if (error) throw new Error(error.message === "laatste beheerder" ? t("users.lastAdmin") : error.message);
      if (!data.length) throw new Error(t("users.notAllowed"));
    },
    async load() {
      const { data, error } = await client.rpc("read_state");
      if (error) throw new Error(error.message);
      // read_state geeft naast het document ook de rol en het bereik waarmee
      // het is uitgelezen. Dat hoort bij elkaar: een document en de afscherming
      // waar het doorheen kwam. Is je rol ondertussen veranderd, dan weten we
      // dat hier en niet pas bij de eerste mislukte opslag.
      if (data && data.role) setMe({ id: me.id, name: me.name, role: data.role, products: data.products });
      lastUpdated = (data && data.updated_at) || null;
      if (!data || data.data == null) return { db: { version: 1, hospitals: [] }, empty: true };
      return { db: data.data, empty: false };
    },
    // mode "import" is een back-up over de data zetten; alles anders is een
    // gewone opslag. De databank houdt die twee uit elkaar omdat een import
    // niets verwijdert en tóch alles terugdraait.
    //
    // De nieuwe tijdstempel komt van de databank en niet meer uit deze browser:
    // bij klokverschil tussen twee toestellen kon de vergelijking slagen waar
    // ze had moeten falen.
    async save(db, mode) {
      const { data, error } = await client.rpc("write_state", {
        payload: db,
        expected_at: lastUpdated,
        mode: mode === "import" ? "import" : "save",
      });
      if (error) {
        if (error.hint === "conflict") throw new ConflictError();
        throw new Error(MELDINGEN[error.hint] ? t(MELDINGEN[error.hint]) : error.message);
      }
      lastUpdated = data;
    },
    async signOut() {
      await client.auth.signOut();
      location.reload();
    },
  };
})();
