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
`data/seed.json` on first run. `data/backups/` keeps `db-vorige.json` (the state
just before the last save, for a one-step undo) and one `db-JJJJ-MM-DD.json` per
day holding the state at that day's **first** change — deliberately not
overwritten, so a bad save cannot take the day's only copy with it.

With `public/config.js` filled in, the app talks to Supabase instead and asks for a
login. `supabase/schema.sql` creates the tables.

Pushing to `main` deploys: GitHub Pages serves the repository root, where `index.html`
redirects to `public/`. Browsers keep the old files until the `?v=` stamp changes, so a
deploy that skips the stamp bump ships nothing.

## Layout

| File | What it is |
|---|---|
| `public/domain.js` | Fixed values both app.js and stats.js need, plus `esc()` |
| `public/app.js` | The whole app: map, list, record, agenda, dialogs, export/import (~1,500 lines) |
| `public/i18n.js` | NL/EN dictionaries and `t()` |
| `public/stats.js` | Statistics page, charts as plain HTML |
| `public/storage.js` | Two backends: local `server.py`, or Supabase with login |
| `public/styles.css` | Prion Medical house style — ink/paper/Jost, amber accent `#d97b2a` |
| `server.py` | Local static server + `GET`/`PUT /api/data` |
| `data/seed.json` | 40 starter hospitals (BE/NL/LU), no contacts, approximate coordinates |

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
`contacts[]`, `activities[]`, `planned[]` and a `unit` object (scope brands and notes,
processor brands and notes — what EndoQ or Ainex actually plugs
into; the fields are `processorBrands` / `processorNotes` but the Dutch labels say
"toren", which is what the team calls it — rooms, rooms with demo/installation, colonoscopies per year, existing
AI, screening). `normalize()` fills
in missing fields — extend it whenever you add one, so older saved data keeps working.

**Planned versus logged.** `activities[]` is the log of what happened, and it drives
status, stage, rooms and both charts. `planned[]` is the agenda and drives none of that —
deliberately a separate array, so a planned installation can never turn a hospital green
or land in the statistics. Ticking a planned moment off opens the contact-moment dialog
prefilled and removes the plan. `nextAction` and `nextActionDate` are **derived** from the
first planned item by `syncNextAction()`, which keeps the list, the "actie te laat" filter
and the CSV working; do not write to them directly. The old `demoDate` field was folded
into `planned[]` the same way: `normalize()` turns it into a planned moment of type
`demo` and drops the field, and the "demo's gepland" KPI and the CSV column both read
`planned[]` now. There is one place to plan a demo, and it clears itself when ticked off.

**Gone quiet.** `isQuiet()` finds the hospitals nobody is chasing: contact has
happened, `planned[]` is empty and the newest `activities[]` entry is at least
`QUIET_DAYS` (90) old. A hospital with something planned is never quiet — it is
either upcoming or "actie te laat" — and one that was never contacted stays red
instead. Derived like `isOverdue()`, so nothing is stored and nothing migrates.

**Status and stage.** Red → orange on first contact; green on installation or order.
`autoStatus()` and `stageStatus()` hold the rules. Manual override must always remain
possible.

**Printing.** `@media print` at the foot of `styles.css` strips the furniture —
map, menu, tab bar, every button — and prints whichever pane is open: the
hospital record, the statistics or the agenda, falling back to the list when
nothing is open. A `<textarea>` only prints what fits in its box, so
`fitTextareasForPrint()` stretches them on `beforeprint` and puts them back
afterwards. Colour carries meaning on these pages, hence `print-color-adjust`.

**CSV export** uses `;` separators, decimal commas and a BOM, because Excel on Belgian
and Dutch locales expects that.

**Cache busting.** Changing anything in `public/` means bumping the `?v=` stamp on
every tag in `public/index.html` — they share one value.

## Privacy

The repository is **public** and GitHub Pages serves it from `main` at
<https://prion-medical.github.io/FollowUpPrion/>. Everything committed is therefore
world-readable *and* fetchable over that URL — `data/`, `supabase/schema.sql` and
`server.py` included. Treat a commit as a publication.

`data/db.json` is gitignored and must stay that way: once real contacts are entered it
holds names, phone numbers and e-mail addresses of identifiable clinicians. Do not
commit it and do not paste its contents into issues or commit messages. The same goes
for `data/seed.json`, which **is** committed: it keeps 40 hospitals with empty
`contacts[]` and `activities[]`, and no clinician's name, phone number or e-mail
address may be added to it. `data/backups/` is ignored for the same reason.

What protects the data is the login, not the repository. Sign-up is disabled on the
Supabase project, so only users created by hand under Authentication → Users can sign
in; keep it that way, and keep 2FA on the accounts that can reach the dashboard.

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
