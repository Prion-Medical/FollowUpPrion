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

**Who entered it.** `activities[]` and `planned[]` each carry `createdBy`,
`createdAt`, `updatedBy` and `updatedAt`. `createdBy` is the user's uuid from
`app_users` (`"local"` when running on `server.py` with a `localUser` in `config.js`,
and `""` when nobody is known). Mind the distinction: `date` is when the contact
moment **happened**, `createdAt` is when someone **entered** it — a visit from last
week gets typed in today. `stamp()` sets them, and it is called from exactly two
places: `activityDialog()` and `plannedDialog()`. Records from before this existed
have empty strings, and everywhere a name is shown, empty means show nothing — better
no name than a made-up one. Contacts and hospitals carry no stamp.

The browser fills these in so the name appears at once, but **the database overwrites
them**: `write_state()` strips whatever the client sent and assigns the stamp itself,
from the id that is actually signed in. It assigns rather than validates, because
validating would need exceptions (an import restores other people's records; old
records have no author) and a check with exceptions proves nothing. An import is the
one carve-out: it restores a backup as it was, stamps included. A record whose id is
new is yours; one whose content changed keeps its author and gets you as last editor;
one that did not change keeps all four values, and if it never had a stamp it does not
get an empty one invented for it.

**One product or several.** A contact moment and a planned moment carry one
`product`; a contact carries `products[]`, because the same clinician is often the
point of contact for both. `normalizeContact()` migrates the old single `product`
and drops the field, the way `demoDate` was folded into `planned[]`. The database
reads both shapes — `followup.in_scope()` branches on whether the record has a
`products` key — and deliberately does **not** rewrite the old shape on the way out:
that would make loading and saving return a different document and break the check
that matters most. A contact is visible as soon as one product overlaps your scope,
and `products` is then trimmed to your scope and merged back with the same
`(stored − yours) ∪ (payload ∩ yours)` rule as the hospital's own ticks, so you
cannot take a colleague's product off someone.

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

The Supabase anon/publishable key in `config.js` is safe to publish — the database
admits only signed-in users, and a signed-in user cannot reach `app_state` at all.
Both tables are revoked from `authenticated`; everything goes through `read_state()`
and `write_state()`, which filter on product. What someone sees and may change is in
their `app_users` row (see Roles below).

## Roles

`public.app_users` holds one row per user beside `auth.users`: a display name, a role
and `products[]`. **`products = '{}'` means unrestricted**, not "no products" — there
is no sensible user who may see nothing, and `viewer` already covers "look, don't
touch".

| Role | May |
|---|---|
| `admin` | everything, plus assigning roles |
| `editor` | everything with the data, including deleting and importing a backup |
| `contributor` | add and change; not delete, not import |
| `viewer` | read, print and export only |

A trigger on `auth.users` gives every new account an `app_users` row at `viewer`, so a
user created by hand in the dashboard starts at least privilege and an admin promotes
them in the app. The schema also promotes the oldest account to `admin` the first time
it runs, otherwise nobody could assign anything. Creating accounts stays a dashboard
job: that needs the service key, which must never be in a public repo.

Three layers enforce this, and only one of them is real security:

- **The database.** An RLS policy on `app_state` lets only `admin`, `editor` and
  `contributor` write. A `viewer` is refused by Postgres whatever the browser does.
- **`scheduleSave()` and `openDialog()`** in `app.js` refuse a write or a delete
  without the right. A backstop, so no forgotten path slips through — and it can say
  so immediately instead of after a failed save.
- **`styles.css`,** keyed on `body[data-rights]`, hides what a role may not do.
  Comfort, not a wall. It lives in CSS and not in JavaScript because every render
  replaces `innerHTML`, which a CSS rule survives and a JS pass does not.

All four are enforced by the database, not just by the browser. `write_state()` takes
an inventory of every record id before and after, so it can see that something *inside*
the document disappeared — that is what makes `contributor`'s "no delete" real. The
same inventory excuses the one legitimate disappearance: ticking a planned moment off
removes it and adds a contact moment **with the same id**, so `activityDialog()`
reuses `plan.id` instead of minting a new one. Change that and a `contributor` can no
longer work through the agenda.

## The product wall

`app_users.products` restricts someone to EndoQ or Ainex, and it is a wall, not a
filter: `read_state()` strips the other product's contacts, contact moments and
planned moments before the row leaves the database, so that data never reaches the
browser at all.

**The wall goes around the data, not around the hospital.** Every hospital stays
visible to everyone — the whole list, the whole map. What a restricted user loses is
the other product's records inside it, that product's tick in `products`, its column
in the statistics and its option in every dropdown. A hospital nobody has logged
anything against yet is simply a prospect the whole team can see.

It worked the other way round at first: a hospital was visible only if its `products`
overlapped yours. With a real dataset, where no hospital has a product assigned until
someone logs a contact, that hid everything from everybody — and ticking both products
on an account reads like "may see everything" while actually meaning "restricted to
these two", which hid the lot. Visibility now depends on nothing at all.

`write_state()` is the dangerous half, because a restricted user only ever holds part
of the document. It therefore builds the new document **from what is stored** and
replaces only the slices that user could see; it never builds from the payload. Two
rules are worth knowing:

- Hospital-level fields and `unit` are **shared** — an Ainex user correcting the
  address shares that with the EndoQ colleague. That is collaboration, not a leak.
  Deleting a hospital is not shared: `followup.vreemde_data()` refuses it when
  anything inside belongs to a product you may not see. Checking `products` alone
  would not do, since an empty `products` is a subset of every scope — and that is
  exactly the hospital that may still hold a colleague's contact moments.
  `products` is the exception: `(stored − yours) ∪ (payload ∩ yours)`, so you cannot
  strip the other product and push a hospital out of a colleague's view.
- Outside an import, at most one hospital and five records may disappear in a single
  save. The app deletes one thing at a time behind a `confirm()`, so no real save ever
  reaches that cap. It catches the case that no merge rule can: a user whose scope was
  just widened sends the small document they were holding, which would otherwise count
  as a wholesale replace.

`unit.roomsDemo` and `nextAction`/`nextActionDate` are recomputed server-side after the
merge, because the client derives them from a list it only half has. `nextAction` is
recomputed on the way **out** as well: it holds the note of the first planned moment,
and that moment may be the other product's — sending it unrecomputed would hand a
restricted browser the text of a record the wall had just removed. `roomsDemo` only
when the demo activities themselves changed: the field is also typed by hand in the
record, and recomputing on every save would wipe what someone put there.
`unit.roomsInstalled` is not: `syncRooms()` applies a *difference*, not a sum, so it is
already safe.

Run `supabase/controle.sql` in the SQL editor after any change to these functions. It
reports OK or FOUT per check and needs no eyeballing; the one that matters is "laden en
opslaan verandert niets".

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
- **Two people editing at once still collide.** The conflict check is per document,
  not per hospital, so an Ainex and an EndoQ user saving in the same second means one
  of them redoes their work — even though they touched different records.
- **"No importing" stops a deletion, not a rewrite.** `mode` comes from the client, so
  a `contributor` with the developer console can send an old backup as an ordinary save:
  if no id disappears, the inventory lets it through and every field is rolled back
  anyway. The inventory is the real line; the import flag is about shape, not intent.
- **Restoring a backup is a dashboard job.** `app_state_backups` is revoked from
  `authenticated`, because it holds the full unscoped document and would have been a
  door next to the wall.
- **No tests.** If this changes, plain Node assertions over the pure functions
  (`normalize`, VRR-style maths, CSV writing, i18n key coverage) — not a test framework.
- **`app.js` is large** for a single file. Splitting it is reasonable eventually, but
  there is no module bundler and no appetite for one, so it stays until the pain is real.
