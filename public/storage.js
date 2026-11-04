/* FollowUp Prion – opslag / storage.
 * Zonder Supabase-gegevens in config.js: lokale server (server.py, /api/data).
 * Met Supabase-gegevens: online databank met login. */
window.FollowUpStore = (() => {
  "use strict";
  const cfg = window.FOLLOWUP_CONFIG || {};
  const t = (k) => window.FollowUpI18n.t(k);
  const ROW = "main";
  const $ = (sel) => document.querySelector(sel);

  class ConflictError extends Error {}

  const local = {
    mode: "local",
    ConflictError,
    async ready() {},
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
        const { error } = await client.auth.signInWithPassword({
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
        });
        btn.disabled = false;
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

  return {
    mode: "supabase",
    ConflictError,
    async ready() {
      const { data } = await client.auth.getSession();
      if (!data.session) await showLogin();
    },
    async load() {
      const { data, error } = await client.from("app_state").select("data, updated_at").eq("id", ROW).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        lastUpdated = null;
        return { db: { version: 1, hospitals: [] }, empty: true };
      }
      lastUpdated = data.updated_at;
      return { db: data.data, empty: false };
    },
    async save(db) {
      const now = new Date().toISOString();
      if (lastUpdated === null) {
        const { error } = await client.from("app_state").insert({ id: ROW, data: db, updated_at: now });
        if (error) throw error.code === "23505" ? new ConflictError() : new Error(error.message);
      } else {
        // Enkel overschrijven als niemand anders (bv. je gsm) ondertussen opsloeg.
        const { data, error } = await client.from("app_state")
          .update({ data: db, updated_at: now })
          .eq("id", ROW).eq("updated_at", lastUpdated)
          .select("updated_at");
        if (error) throw new Error(error.message);
        if (!data.length) throw new ConflictError();
      }
      lastUpdated = now;
    },
    async signOut() {
      await client.auth.signOut();
      location.reload();
    },
  };
})();
