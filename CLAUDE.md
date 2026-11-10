# FollowUp Prion — working notes

Sales follow-up for **EndoQ** (ScopeWatch) and **Ainex** (ENAD), two AI-assisted
colonoscopy systems Prion Medical distributes in the **Benelux**, and since November
2026 also for **Thyroid RFA** and **Fibroid RFA**, which are sold per procedure
rather than per subscription. A map of hospitals,
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
login. `supabase/schema.sql` creates the tables. There are two such projects — see
Two databases below.

Pushing to `main` deploys: GitHub Pages serves the repository root, where `index.html`
redirects to `public/`. Browsers keep the old files until the `?v=` stamp changes, so a
deploy that skips the stamp bump ships nothing.

## Two databases

There are two Supabase projects: the live one and a development one. `public/config.js`
holds both key pairs and chooses between them by **hostname** — `localhost`,
`127.0.0.1`, `[::1]` and a page opened as a file get development, everything else gets
live. The choice is made at runtime, not per branch, so the published app cannot reach
the development database, a deploy cannot carry a development key, and merging `dev`
into `main` leaves nothing to strip. Comment the two development lines out and
`localhost` falls back to `data/db.json` through `server.py`, which is still the
quickest way to work on anything that is not about the database.

The development project exists so that a schema change can be tried before it reaches
anyone's work: run `schema.sql` there first, then `versie.sql`, `toegang.sql` and
`controle.sql`, and only then the same against the live project — from disk, as ever.

It holds **invented data only**: the forty hospitals from `data/seed.json` plus made-up
clinicians on `example.com`. Never an export from the live database. That would put
real contact details in a second database with its own user list, and the convenience
is not worth it. Sign-up is off there too, because the project URL sits in a public
repository. It is on the free plan, so it **pauses after a week without traffic** —
restoring it is one click and nothing is lost.

Four accounts cover every rule: an `admin`, a `viewer`, a `contributor` limited to
Ainex and an `editor` limited to EndoQ. The last two are the point, because the product
wall can only be judged from both sides at once. Give each one a name in `app_users`
first: the user screen shows names and no e-mail addresses, so fresh accounts are four
identical blank rows.

Two things that cost an evening to find out:

- **Part C of `controle.sql` wants a uuid in five places.** It can look itself up
  instead: `set_config('request.jwt.claims', …, true)` does what the `set local` line
  there does and accepts a subquery. Look the uuid up *before* switching role, since
  `authenticated` may not read `auth.users`. Run those blocks one at a time — the first
  failure stops the whole transaction, and three of them are supposed to fail.
- **Seeding by writing to `app_state` directly** leaves a document that never went
  through `write_state()`, and C2b then reports FOUT for no good reason:
  `merge_hospital()` always writes a `planned` key and `seed.json` has none, so the
  first save legitimately changes 32 hospitals. Push such a document through
  `write_state()` once as an unrestricted user before trusting `controle.sql` on it.

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

**The dropdown.** `pickBox()` in `public/domain.js` is the one multi-select in this
app: the three sidebar filters, a contact's products, a contact moment's and a planned
moment's product, a user's scope and the statistics filter. It takes its rows as
**data**, not as markup — `{ attrs, label, checked, cls?, type? }` — and that is the
whole point: it therefore knows what is ticked and what each row is called, so it owns
the summary on the button, both when first rendered and on every tick. Five screens
each kept that summary themselves before, with five different data attributes. A screen
that moves ticks itself calls `syncPick()`, because a checkbox set from JavaScript
fires no `change`. `attrs` goes into the tag unescaped — they are attributes and not
text — so the caller wraps its own values in `esc()`, as everywhere else here. A row
called "all" is a row like any other, which is why "all products" is also automatically
the text on the button. `type: "radio"` makes it a choice of one.

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

**Adding a product.** `PRODUCTS` in `public/domain.js` is the only list on the
client side: the sidebar filter, all three dialogs, the user screen and the
statistics read it, and everything that exists per product is derived from it —
`productColor()` maps it onto `--series-1` … `--series-6` in `styles.css`, and
`emptyTargets()` builds the target row. `myProducts()` lives there too, so
`app.js` and `stats.js` restrict to a user's scope the same way. The database
needs its own copy, since it cannot read that file: `followup.producten()` in
`supabase/schema.sql`. That one only fixes the sort order — an unknown product
sorts last rather than being refused, so an app that already knows a new product
does not break against a database that has not been updated yet. So: two lines,
one per side, and a seventh product also wants a `--series-7`.

**Two kinds of product.** `productKind()` in `public/domain.js` says how a product is
sold: `"subscription"` (EndoQ, Ainex: per room, counted in rooms and active
subscriptions) or `"procedure"` (Thyroid RFA, Fibroid RFA: used up per procedure, no
installation, counted in units ordered). Anything not listed is a subscription, so an
unknown product behaves as everything did before. `PRODUCTS` deliberately stays a list
of names — the name is what is stored on every record and in every scope — and what a
product *is* hangs beside it. Three things follow from the kind and should keep doing
so instead of naming products: `wantsQuantity()` (the one number on a contact moment
is rooms for a subscription product and units for a procedure product, and there only
on an order), `stagesFor()` (one shared list of stages, of which a procedure product
skips "demo installed" and a subscription product skips "purchase started"), and the
statistics page, which shows subscriptions, rooms and towers for the one kind and
orders per month for the other. `syncRooms()` ignores procedure products. Units
ordered is a sales figure per hospital per month — never a record per patient or per
procedure.

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
cannot take a colleague's product off someone. Only `products` is merged that way:
the contact's own fields — name, phone, e-mail, notes — are **shared**, exactly as
the hospital's are. Two people looking after the same clinician edit the same
record, and the last save wins.

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

**The logbook.** The agenda page has two tabs: what is planned (`planned[]`) and the
logbook, every contact moment across hospitals, newest first and grouped per week
(`renderLog()`). It is not a view of its own — `state.agenda.tab` chooses — so the tab
bar, `setView()` and the print rules did not have to learn anything. Product, country,
owner and the search term are the map's own (`state.filter`), in both directions;
period, type and "entered by" exist only here (`state.log`). The filter row is drawn
once and only the list below it is redrawn (`renderLogBody()`), or an open dropdown
would close on every tick. Editing goes through `activityDialog()`, the same one the
record uses; adding stays in the record. The wall needs nothing extra: the database
only sends the contact moments within scope.

**Gone quiet.** `isQuiet()` finds the hospitals nobody is chasing: contact has
happened, `planned[]` is empty and the newest `activities[]` entry is at least
`QUIET_DAYS` (90) old. A hospital with something planned is never quiet — it is
either upcoming or "actie te laat" — and one that was never contacted stays red
instead. Derived like `isOverdue()`, so nothing is stored and nothing migrates.

**Status and stage.** Red → orange on first contact; green on installation or order.
`autoStatus()` and `stageStatus()` hold the rules. Manual override must always remain
possible.

**Follow-up per product.** `h.pipeline` holds one row per product:
`{ stage, status, owner }`, where `owner` is a uuid from `app_users`. A hospital can
be an EndoQ customer and a Thyroid RFA prospect at once. `h.status` and `h.stage` on
the hospital are **derived** from it — the product that is furthest along, colour
first, then stage (`furthest()` in `domain.js`) — exactly as `nextAction` is derived
from `planned[]`; do not write to them while a product is ticked. Only a hospital with
no product ticked keeps a status and stage of its own. `syncPipeline()` keeps all this
in step and is called wherever `h.products` or a row changes. A row is never deleted
when its tick goes: it is ignored while unticked and comes back with the tick.
`pipelineView(h, products)` is what the map, the list, the counters and the statistics
show: with a product filter, the furthest of *those* products; without, the hospital
as a whole. "Overdue", "gone quiet" and "demo planned" follow the same filter through
`inFilter()`. A contact moment moves the row of its own product; one without a product
moves the only row there is, and nothing when there are several.

**What you need to know for an RFA product** — CMM approval, priority, whether they
already perform RFA, the current system and a note — is the counterpart of the
endoscopy unit, and shows as a section of its own per product. It is stored in that
product's row in `h.pipeline` (`normalizeFacts()`), not in a block on the hospital
like `unit`: Thyroid and Fibroid each have their own approval at the same hospital,
and a row is already inside the product wall, so these facts never reach an account
without the product. `h.network` and `h.sites` are ordinary shared hospital fields.

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

`pipeline` sits inside the wall like a contact moment. `scope_hospital()` passes only
the rows within scope and recomputes the hospital's status and stage on what is left
(`fix_overall()`), so that "green, customer" does not give away how far the other
product is. `merge_hospital()` keeps the colleague's rows as stored and recomputes on
the full set, because a restricted browser computed the whole from the half it could
see. `followup.fases()` is the database's copy of `STAGES`, as `producten()` is of
`PRODUCTS`. A restricted user gets no hospital-level status or stage controls at all:
where a colleague's product is attached the database would discard the click.

Going from one stage per hospital to a row per product is done **in the database, for
every product at once** (`followup.opvolging_aanvullen()`): once on the stored
document at the foot of `schema.sql`, and again in `read_state()` and `write_state()`
for an old document that still turns up. Leaving it to the app is what goes wrong — a
restricted user's app knows one product, creates one row, and the colleague then finds
a hospital "with follow-up" in which his product is missing. Run `schema.sql` on the
live project at the moment the new app is deployed, not days before: the previous app
writes `h.status` directly and the new one would overrule it from `pipeline`.

Run `supabase/controle.sql` in the SQL editor after any change to these functions. It
reports OK or FOUT per check and needs no eyeballing; the one that matters is "laden en
opslaan verandert niets".

**Re-running `schema.sql` is the step that goes wrong.** It is all `create or replace`,
so running an *older* copy applies cleanly and silently reverts functions — a fix that
was already live can disappear this way, and it has, repeatedly. The tell is that
`controle.sql` fails only on its newest checks while every older one passes. So copy the
file off disk rather than reusing a SQL editor tab (`pbcopy < supabase/schema.sql`), and
run `supabase/versie.sql` first: it reads `pg_proc` and reports per function whether the
database holds the current body. Add a line there whenever a function changes
materially, or it stops guarding anything.

`supabase/toegang.sql` is the third one, and the one to run now and then rather than
after a change: it checks that the grants, the RLS and the roles are still what the
schema intends — `app_state` and `app_state_backups` unreachable, no `usage` on
`followup`, the two RPCs executable, every account with a row, at least one admin. It
cannot see whether sign-up is disabled or whether 2FA is on, because neither lives in
the database; the file names both at the foot.

## Git

- Repository lives in the **Prion-Medical** organisation; push as the `PrionMedical`
  account, never the personal one (`gh auth switch --user PrionMedical`).
- Commits are authored `Dante Kerstens <dante@prionmedical.be>`, set per-repo.
- **No AI attribution** in commit messages or PR descriptions — no `Co-Authored-By`
  trailer, no "Generated with" footer.
- Commit messages in Dutch or English, either is fine. **Branch names and pull request
  titles in English.**
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
