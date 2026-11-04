# FollowUp Prion — working notes

Sales follow-up for **EndoQ** (ScopeWatch) and **Ainex** (ENAD), two AI-assisted
colonoscopy systems Prion Medical distributes in the **Benelux**. A map of hospitals,
a record per hospital with contacts, contact moments and endoscopy-unit details, and a
statistics page. Bilingual Dutch / English.

Written in English because it is tooling-facing. **Code comments and all user-visible
text are Dutch** (translated to English through the i18n layer) — keep it that way.

## Hard constraints

These are deliberate. Do not change them without asking.

- **No dependencies, no build step, no package manager.** There is no `package.json`
  and there should not be one. Leaflet and the Supabase client come from a CDN with
  an SRI hash; everything else is hand-written.
- **The server is Python standard library only** (`server.py`, ~100 lines). No Flask,
  no FastAPI, no `pip install`.
- **No patient data, ever.** This is a sales CRM. It holds hospitals, clinicians'
  professional contact details and endoscopy-unit facts. The predecessor app
  (FollowUpVaseo) stored anonymised clinical records per procedure; that was removed
  on purpose and must not come back.
- **No frameworks.** No React, Vue, Tailwind, bundler, transpiler or test runner.

If a skill, linter or review suggests otherwise — and general-purpose skills will —
**this project's conventions win**. Raise the suggestion, do not act on it.

## Running it

```bash
python3 server.py        # then open http://localhost:8080
```

Or double-click `start.command`. Data lives in `data/db.json`, created from
`data/seed.json` on first run, with a daily copy in `data/backups/`.

With `public/config.js` filled in, the app talks to Supabase instead and asks for a
login. `supabase/schema.sql` creates the tables.

## Layout

| File | What it is |
|---|---|
| `public/app.js` | The whole app: map, list, record, dialogs, export/import (~1,100 lines) |
| `public/i18n.js` | NL/EN dictionaries and `t()` |
| `public/stats.js` | Statistics page, charts as plain HTML |
| `public/storage.js` | Two backends: local `server.py`, or Supabase with login |
| `public/styles.css` | Prion Medical house style — ink/paper/Jost, amber accent `#d97b2a` |
| `server.py` | Local static server + `GET`/`PUT /api/data` |
| `data/seed.json` | 39 starter hospitals (BE/NL/LU), no contacts, approximate coordinates |

## Conventions

**Translations.** Every visible string goes through `t("key")`. The database stores
**neutral keys**, never translated text — `stage: "customer"`, `type: "installation"`,
`country: "BE"`, `sector: "university"`. This keeps one dataset readable in both
languages. Adding a key means adding it to **both** `nl` and `en`; a missing key falls
back to Dutch and then renders the key itself, so it is visible rather than silent.
Static markup uses `data-i18n`, `data-i18n-ph`, `data-i18n-title`.

**Rendering.** Views are built as HTML strings and assigned with `innerHTML`. Every
interpolated value that could come from a user **must** be wrapped in `esc()`. This is
a discipline, not a guarantee — when editing a template, check it. Translated strings
and numbers are ours and safe.

**Data shape.** One document: `{ version, hospitals: [...] }`. Each hospital carries
`contacts[]`, `activities[]` and a `unit` object (scope brands, rooms, rooms with
demo/installation, colonoscopies per year, existing AI, screening). `normalize()` fills
in missing fields — extend it whenever you add one, so older saved data keeps working.

**Status and stage.** Red → orange on first contact; green on installation or order.
`autoStatus()` and `stageStatus()` hold the rules. Manual override must always remain
possible.

**CSV export** uses `;` separators, decimal commas and a BOM, because Excel on Belgian
and Dutch locales expects that.

**Cache busting.** Changing anything in `public/` means bumping the `?v=` stamp on
every tag in `public/index.html` — they share one value.

## Privacy

`data/db.json` is gitignored and must stay that way: once real contacts are entered it
holds names, phone numbers and e-mail addresses of identifiable clinicians. Do not
commit it, do not paste its contents into issues or commit messages, and keep the
repository private.

The Supabase anon/publishable key in `config.js` is safe to publish — RLS allows only
authenticated users. Note the current policy is all-or-nothing: any signed-in user can
read and write everything.

## Git

- Repository lives in the **Prion-Medical** organisation; push as the `PrionMedical`
  account, never the personal one (`gh auth switch --user PrionMedical`).
- Commits are authored `Dante Kerstens <dante@prionmedical.be>`, set per-repo.
- **No AI attribution** in commit messages or PR descriptions — no `Co-Authored-By`
  trailer, no "Generated with" footer.
- Commit messages in Dutch, matching the code comments.
- `.claude/` is gitignored, skills included.

## Known and accepted

Not bugs; decisions. Reviewers will flag them, so the reasoning is recorded here.

- **One JSON document, last-write-wins** with an `updated_at` check. A conflict is
  detected and reported rather than silently lost, but two people editing at once means
  one of them redoes their work. Fine for a handful of users; it does not scale further.
- **Blanket RLS.** Any authenticated user sees everything. Acceptable while the user
  base is the Prion team.
- **No tests.** If this changes, plain Node assertions over the pure functions
  (`normalize`, VRR-style maths, CSV writing, i18n key coverage) — not a test framework.
- **`app.js` is large** for a single file. Splitting it is reasonable eventually, but
  there is no module bundler and no appetite for one, so it stays until the pain is real.
