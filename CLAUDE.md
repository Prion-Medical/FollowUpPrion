# FollowUp Prion — working notes

Sales follow-up for **EndoQ** (ScopeWatch) and **Ainex** (ENAD), two AI-assisted
colonoscopy systems Prion Medical distributes in the **Benelux**, and since November
2026 also for **Thyroid RFA**, **Fibroid RFA** and **Stents**, which are sold per
piece rather than per subscription. A map of hospitals,
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
python3 server.py        # then open http://localhost:8081
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

## Checking the copies

Some rules live in more than one place, because the app, the connector, the database
and the calendar feed cannot share a file: the product, stage and type lists, the type
names, what a contact moment does to the colour, stage and rooms, and what an event
looks like. Nothing fails when two copies drift apart, so `tests/` checks it:

```bash
node --experimental-strip-types tests/alles.mjs   # the flag can go from Node 23.6
```

| File | Checks |
|---|---|
| `tests/lijsten.mjs` | Products, stages, types (and their names), kinds of stent and facts per product agree between `domain.js`, `i18n.js`, the connector, the calendar function and `schema.sql` |
| `tests/vertalingen.mjs` | Every key in both languages, and every key the code asks for exists |
| `tests/regels.mjs` | The same contact moments, new and edited, through `domain.js` and the connector's `add_contact_moment` / `update_moment` give the same colour, stage, follow-up, rooms and stored record; the connector accepts exactly the types `typesAmong()` offers, for no product, one, two, a shared moment and a restricted account |
| `tests/planning.mjs` | Planned moments: planning without a date, the order (date, time, undated first) in the app, the connector and `fix_planned()`, ticking off (id reused, time dropped, kind of stent kept, date at the latest today) and "planned for" |
| `tests/cijfers.mjs` | Units sold, per kind of stent, and active rooms: `domain.js`'s counting against the connector's `get_statistics`, with awkward quantities |
| `tests/samenvoegen.mjs` | `merge3()`: both sides' edits survive, a real clash is a conflict, deletions, stamps, ticks, the list form |
| `tests/agenda.mjs` | The download (`ics.js`) and the feed write the same events, and the feed answers 404 / 503 correctly |

Each file runs in its own process (`alles.mjs`), and within a file every case is
reported, so one run lists everything that is broken. Run it before every commit,
the way `controle.sql` is run after every schema change.
It needs no browser, no database and no network: the rules come from `domain.js`, and
the Edge Functions run against a faked `fetch`. It uses invented
data only — the repository is public. `roomsDemo` is left out of the comparison on
purpose: the connector leaves it to `fix_rooms_demo()` in the database.

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
| `public/domain.js` | Fixed values and pure rules both app.js and stats.js need: what a contact moment does to colour, stage and rooms (`autoStatus`, `syncPipeline`, `syncRooms`), the order of planned moments (`byWhen`), how units and rooms are counted, plus `esc()` and `pickBox()`. The connector copies these; `tests/` compares the copies |
| `public/ui.js` | What the page does without knowing about hospitals: icons, `leave()`, `ask()`, row motion, the sliding switch, the select list |
| `public/app.js` | The whole app: map, list, record, agenda, dialogs, export/import (~1,500 lines) |
| `public/i18n.js` | NL/EN dictionaries and `t()` |
| `public/stats.js` | Statistics page, charts as plain HTML |
| `public/storage.js` | Two backends: local `server.py`, or Supabase with login |
| `public/theme.js` | Light, dark or system: sets `data-theme` on `<html>` before anything is drawn |
| `public/styles.css` | The look: white panels on cool grey, system font, one blue accent `#2563eb`, light and dark |
| `server.py` | Local static server + `GET`/`PUT /api/data` |
| `data/seed.json` | 40 starter hospitals (BE/NL/LU), no contacts, approximate coordinates |
| `public/consent.html`, `consent.js` | The page where someone allows an assistant to act as them (see The assistant connector) |
| `supabase/functions/agent/index.ts` | The connector an assistant such as Claude talks to: a Supabase Edge Function, one file, no imports |
| `public/ics.js` | Writes iCalendar: one planned moment as a file to download |
| `supabase/functions/calendar/index.ts` | The calendar feed a calendar app fetches: an Edge Function, one file, no imports (see The calendar feed) |
| `docs/agent-instructions.md` | What to paste into the assistant's project so it behaves like a colleague who keeps the log |

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

**The look.** `styles.css` opens with every token: surfaces, ink, one accent, the
three status colours each as a full colour (dots, pins), an `-ink` (text) and a
`-soft` (the ground behind it), and `--series-1` … `--series-6`. The accent is one
value, `--accent` (light and dark each have theirs), with `--on-accent` for the text
on top of it; hover, soft, line, ink and focus ring are derived with `color-mix()`.
There are five
font sizes (`--t-xs` … `--t-lg`, 11/12/13/15/18) and `--t-xl` for the figures on the
statistics page; pick one of those rather than writing a pixel value. The phone block
remaps the same tokens one step larger, so inputs reach 16px and iOS does not zoom.
Dark mode is the same token names under `:root[data-theme="dark"]` inside `@media
screen` — `screen`, so a print is always light. `public/theme.js` sets that attribute
from the choice in the menu (system, light or dark, kept in `localStorage`); it loads
in the `<head>` so the page does not flash white first, and it is a file of its own
because the CSP allows no inline script. A rule that needs a different value in
the dark gets a token, not a second rule: a rule inside that block that also exists
further down the file loses to it. Icons are `icon("edit")` from `ui.js`, inline
SVG in the colour of the text beside them; no glyphs from the font. Motion is short
and all of it is switched off under `prefers-reduced-motion`. The one piece with
JavaScript behind it is the highlight that slides between the buttons of an `.s-seg`
(`segSlide()` in `ui.js`): the screens rebuild their `innerHTML` on the click, so
it measures where the highlight is in the capture phase and re-creates it in the new
markup. The movement itself is a CSS transition on `transform` with `--spring`, which
is what makes a click halfway turn it round. The font is the
device's own, so nothing is fetched from Google Fonts any more; the CSP still allows
it and was left alone.

**The dropdown.** `pickBox()` in `public/domain.js` is the one multi-select in this
app: the three sidebar filters, a contact's products, a contact moment's and a planned
moment's product, a user's scope and the statistics filter. It takes its rows as
**data**, not as markup — `{ attrs, label, checked, cls?, type? }` — and that is the
whole point: it therefore knows what is ticked and what each row is called, so it owns
the summary on the button, both when first rendered and on every tick. Five screens
each kept that summary themselves before, with five different data attributes. A screen
that moves ticks itself calls `syncPick()`, because a checkbox set from JavaScript
fires no `change`. A fourth argument is what goes in front of the names once
something is ticked — "Assigned to: Anna" — for a dropdown whose rows are people and
do not say what they stand for; filters carry their wording inside the field and
never as a label in front of it. `attrs` goes into the tag unescaped — they are attributes and not
text — so the caller wraps its own values in `esc()`, as everywhere else here. A row
called "all" is a row like any other, which is why "all products" is also automatically
the text on the button. `type: "radio"` makes it a choice of one; nothing uses
that at the moment.

**Questions and messages.** No `confirm()` or `alert()`: `ask(msg)` in `ui.js` opens
the app's own dialog (`#ask`) and promises true or false, `tell(msg)` is the same box
with one button. A form dialog with a delete button passes its question as the third
argument of `openDialog()`, which asks it with the form still open underneath, so
"Annuleer" puts you back where you were. A fourth argument, `{ beforeClose }`, is a
question asked before the dialog closes by any route, Escape included; it belongs to
that dialog and the next `openDialog()` drops it. The subscription dialog uses it
twice: not while the database is still making the address, and not without asking
when the address was never copied. The banner under the top bar takes a tone,
`showBanner(msg, reload, "error" | "warn" | "info")`, and is red unless told otherwise.

**Making things go away.** Anything that closes with a fade goes through
`leave(el, after, opts)` in `ui.js`: it fades the element and only then runs `after`,
which is what really removes it (set `hidden`, close the dialog, drop the node).
`stay(el)` calls a leave off when the thing is reopened meanwhile. One mechanism for
the record, the menu, the toast, both dialogs and both kinds of dropdown — no CSS
exit rules, and no timer elsewhere that has to match a duration. It runs on a clock
rather than on an animation event, because that event waits for the next frame and a
window that is not being drawn never sends it.

**Select lists.** A `<select>` stays a `<select>`, but with a mouse its list is drawn
by `selShow()` in `ui.js` (`.sel-list` in `styles.css`): the system's own list
opens over the field on a Mac and hides which field you are in. One listener on the
document holds the native list back and shows ours under the field, or above it; a
choice sets the select's value and fires an ordinary `change`, so no screen had to be
converted and a new select joins in by existing. On a touch screen nothing is
intercepted and the device shows its own picker.

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

**Regions.** `REGIONS` in `public/domain.js` says which countries make up a
region and which piece of map belongs to it; `COUNTRIES` is derived from it. A
hospital stores no region: `regionOf(h.country)` works it out, so the two cannot
disagree and old data needs nothing. The chosen regions live in `state.regions`,
beside `state.filter` rather than in it, and are remembered per browser
(`followup-regions` in `localStorage`): it is where you work, not a search, so
"clear filters" leaves it alone. It narrows the list, the map, the counters, the
logbook and the statistics, decides which countries the country filter offers and
where the map opens. Exports are not narrowed. **A region only counts once a
hospital lies in it** (`liveRegions()` in `app.js`): the table lists the Benelux
and Australia, but while every hospital is in the Benelux no region filter is
drawn and the map opens there, and the first hospital given an Australian
address brings the filter with it. The country field in the record and in the
new-hospital dialog always offers every country, or that first one could never
be entered. Adding a region is one line there plus `region.x` and `country.XX`
in both languages; mind that `normalize()` empties a country that is not on the
list. It is a filter and not a wall — nothing in
the database knows about it. If it ever has to become one, it would key on
`country` in `read_state()`, with its own copy of the table as `producten()` is of
`PRODUCTS`, and it would end "every hospital stays visible to everyone".

**Two kinds of product.** `productKind()` in `public/domain.js` says how a product is
sold: `"subscription"` (EndoQ, Ainex: per room, counted in rooms and active
subscriptions) or `"procedure"` (Thyroid RFA, Fibroid RFA, Stents: used up per procedure, no
installation, counted in units sold). Stents is one product for every stent
we sell, not one per model. Anything not listed is a subscription, so an
unknown product behaves as everything did before. `PRODUCTS` deliberately stays a list
of names — the name is what is stored on every record and in every scope — and what a
product *is* hangs beside it. Three things follow from the kind and should keep doing
so instead of naming products: `wantsQuantity()` (the one number on a contact moment
is rooms for a subscription product and units for a procedure product, and there only
on an order or a procedure), `stagesFor()` (one shared list of stages, of which a procedure product
skips "demo installed" and a subscription product skips "purchase started"), and the
statistics page, which shows subscriptions, rooms and towers for the one kind and
units sold per month for the other. `syncRooms()` ignores procedure products. Units
sold is a sales figure per hospital per month — never a record per patient or per
procedure.

**Types of contact moment.** `ACT_TYPES` is every type that can be stored;
`typesFor(product)` is what a dialog offers. A product sold per piece has no
installation and no cancellation, a subscription product has no procedure, and
`prospecting` is offered nowhere any more (it said that a hospital was approached
but not how). The lists only narrow the choice: a saved moment keeps a type that is
no longer offered and still shows it. The type dropdown in both moment dialogs
follows the product chosen there, and the logbook's type filter follows the
products filtered on.

**A procedure** (type `procedure`) is a visit: a colleague stands by or assists
while the doctor uses the product. Product that is only shipped is an order. Its
one number is units *used*, and those count as sold (`SOLD_TYPES`), so the same
units must not also be entered as an order — the dialog says so. A procedure
without a number counts for nothing in the figures, where an order without one
counts as one. It moves the product to "under evaluation" when it stood earlier
and never moves a customer. This type sits closest to the no-patient-data rule:
a date, a hospital, a doctor, a number and a few words, never anything about the
patient and never a record per case.

**Kinds within a product.** `FAMILIES` in `domain.js` gives Stents four:
oesophageal, biliary, colonic and other. A moment that carries a number, so an
order or a procedure (`wantsFamily()`), can carry one `family`, also while it is
still planned (ticking it off takes the kind along), stored only when chosen, so older
records are not rewritten. One per moment: an order of two kinds is two moments.
The statistics show units per kind, with "no kind chosen" as its own row so the
sum matches the tile.

**One product or several.** A contact moment and a planned moment usually carry
one `product`; a contact carries `products[]`, because the same clinician is often
the point of contact for both. A moment can be about several products too (one
meeting about Thyroid RFA and Fibroid RFA): it then carries `products[]` instead,
and `productsOf()` / `productOf()` in `domain.js` are how every screen reads
either shape. Existing moments are **not** converted, or the first save would make
one person the last editor of the whole logbook; the list appears when someone
ticks a second product, and from then on that record stays a list even if one
product is left. That last part is not tidiness: a restricted user holds only
their own part of the list, and the database only adds the colleague's part back
while the record is a list. Whatever carries a number belongs to one product. So a
*new* contact moment about several products with a type that carries a number (an
order for Fibroid RFA and Stents) asks for a number per product and is saved as one
contact moment per product, each with its own number and kind of stent; the first
keeps a ticked-off plan's id. A plan carries no number, so it may be any type all its
products know (`typesInAll()`); the numbers come when it is ticked off. An existing
moment in the list form, and a shared plan ticked off by someone who may not see all
its products, offer only the types without a number (`typesAmong()`), with no
quantity and no kind of stent: the colleague's product may be hidden in it. The
connector does not split: it refuses a number on several products and says to log
one moment per product. Such a moment
moves the follow-up of each of its products, shows under each in the filters,
and counts once as a contact moment. Its note is shared between the people who
can see it, as a contact's fields are, and either of them can remove it.

**A moment in the list form is shared, and never carries a number.** That holds
even when only one product is left in the list, and even when someone who may see
only one product looks at it: the database has trimmed the list for them, so it
looks like a single-product moment but is not. `shared()` in `domain.js` is the
test; `typesAmong(list, mine, gedeeld)` then offers no type with a number, the
dialogs show no quantity and no kind of stent, `normalize()` drops them, and the
connector refuses them. The database is the safety net: `followup.zonder_aantal()`
strips `rooms` and `family` from any list-form record it merges. Ticking off a
shared plan keeps the list form, and `followup.afgevinkt()` hands the merge the
stored plan as the stored side of the new contact moment, so the colleague's
product stays on it (`controle.sql` 71–74). `normalizeContact()` migrates the old single `product`
and drops the field, the way `demoDate` was folded into `planned[]`. The database
reads both shapes through `followup.products_of()`, the counterpart of `productsOf()`,
and deliberately does **not** rewrite the old shape on the way out:
that would make loading and saving return a different document and break the check
that matters most. A contact is visible as soon as one product overlaps your scope,
and `products` is then trimmed to your scope and merged back with the same
`(stored − yours) ∪ (payload ∩ yours)` rule as the hospital's own ticks, so you
cannot take a colleague's product off someone. Only `products` is merged that way:
the contact's own fields — name, phone, e-mail, notes — are **shared**, exactly as
the hospital's are. Two people looking after the same clinician edit the same
record, and the last save wins.

**The main contact.** One per product, not one per hospital: the radiologist who
performs thyroid RFA and the gynaecologist for fibroids are both the person to
call. There is no field per product for it. A contact's `primary` counts for the
products that contact is ticked for, and `setMain()` in `public/domain.js` only
takes the star from contacts that stand on the same ground: they share a product,
or one of the two is ticked for none and so stands for the hospital as a whole.
The price of having no separate field is that someone ticked for two products is
the main contact for both or for neither. `mainContact(h, product)` is what the
list, the two moment dialogs and the export ask; the merge and the connector
follow the same rule.

**Planned versus logged.** `activities[]` is the log of what happened, and it drives
status, stage, rooms and both charts. `planned[]` is the agenda and drives none of that —
deliberately a separate array, so a planned installation can never turn a hospital green
or land in the statistics. Ticking a planned moment off opens the contact-moment dialog
prefilled and removes the plan. `nextAction` and `nextActionDate` are **derived** from the
first planned item by `syncNextAction()`, which keeps the list, the "actie te laat" filter
and the CSV working; do not write to them directly. The old `demoDate` field was folded
into `planned[]` the same way: `normalize()` turns it into a planned moment of type
`demo` and drops the field, and the "demo's gepland" KPI and the CSV column both read
`planned[]` now. There is one place to plan a demo, and it clears itself when ticked off. A demo planned
without a date counts as planned too: it still has to be arranged.

A planned moment may have **no date**: something that has to happen but has no day
yet. It sorts first (an empty date sorts before any other, in `normalize()`,
`byWhen()`, `sortPlanned()` in the connector and `fix_planned()` in the database),
stays at the top of the hospital's planned moments and in its own block above the
agenda, is never overdue (`isLate()`, and `isOverdue()` looks at the first moment
*with* a date), and is the next action with an empty `nextActionDate`. Ticking it off
asks for a date, today by default. It is not in a calendar feed and has no download.
Until November 2026 such a moment was thrown away in three places — `normalize()`,
`fix_planned()` and `doc_keys()` — and an older app or schema still does that, so
**this schema and this app go live together**: an old app would drop every undated
moment on its next save. `doc_keys()` now counts them, so removing one is a deletion
like any other and a `contributor` cannot.

A planned moment can carry a `time` (`"14:00"`), and only when someone gave one —
like `assignee`, writing an empty one onto every older moment would make the first
saver the last editor of the agenda. It belongs to the plan: ticking off builds a
fresh contact moment, so the time is dropped, and a contact moment has a date and
no time. `h.planned` is stored in `byWhen()` order — date, then time (a moment
without a time after those with one), undated first — and `fix_planned()` and the
connector's `sortPlanned()` sort the same way, so the next action is the moment the
agenda shows first. Ticking off dates the contact moment at the latest today
(`tickOffDate()`): a plan for next week ticked off now happened today.

**Assigned to, and planned for.** Two things belong to a person, and they have two
words on purpose. A product at a hospital is *assigned to* someone: `owner` in that
product's row in `h.pipeline` (the field kept its name; the label became "Assigned
to"). A planned moment is *planned for* someone: `assignee` on the entry in
`planned[]`. They shared "Assigned to" for a day, until the agenda page showed both
filters, one per tab, with the same label and a different meaning. The connector
follows the same split: `assign_to` on a product's follow-up, `planned_for` on a
planned moment. A planned moment is for whoever entered it unless someone
else is chosen, so `assigneeOf()` falls back to `createdBy`, and **the field is only
stored when it differs from the author**. That is not tidiness: writing an empty
`assignee` onto every older moment would make the first person to save the last
editor of the whole agenda. The dialog offers only colleagues whose scope includes
the moment's product — a convenience and not a wall, since the database hides the
moment from anyone else anyway. Ticking a moment off drops the assignment. Lists of
people put the signed-in user first, marked "(me)" (`personLabel()`).

**Where you were.** A reload reopens the same screen: `pagehide` writes the view,
the open hospital, the agenda tab and the map's position to `sessionStorage`
(`followup-place`) — per tab, so opening the app afresh still starts on the map.
`showPlaceEarly()` restores it before the data is there, with `state.loading`
making `setView()` draw placeholders (`skelAgenda()`, `skelStats()`, `skelFiche()`)
instead of an empty screen; `restoreSelection()` and `restoreView()` finish the job
around the first `renderAll()`. The users screen waits for the data, because who may
see it is not known before sign-in.

**Sections of the record** fold: the heading is a button (`secHead()` in
`app.js`) with an arrow that points right when closed and down when open. What is
closed is remembered per browser (`followup-sections` in `localStorage`) and
applies to every hospital, since it is about what someone works with and not
about one record. The click only switches a class, so nothing is redrawn and a
half-typed field survives; a print always shows everything.

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
endoscopy unit, and `factsFor(product)` says which of them a product keeps: all
five for the RFA products, only the note for Stents (CMM approval
differs per kind of stent, so one field per hospital would mean nothing). It
shows as a section of its own per product, and is stored in that
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

An assistant connected through the connector is a new recipient of that data:
clinicians' names, numbers and the notes about them go to it and into that chat's
history, outside the database. That was already true of the workbook it replaces,
but it is now something this project does on purpose, and it belongs in whatever
record of processing Prion keeps.

A calendar feed is another such recipient. Each subscription sends the agenda —
hospital names and addresses, the type, product, time and note of each planned
moment — to whichever calendar provider the subscriber uses, from where it reaches
phones and lock screens, and the note travels further than before. The address is a
key that works without signing in until it is stopped. Supabase's function logs
record the address too, secret included, for as long as they are kept. This belongs
in the same record of processing.

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
  save. The app deletes one thing at a time behind a confirmation, so no real save ever
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
`followup`, the three RPCs executable, every account with a row, at least one admin. It
cannot see whether sign-up is disabled or whether 2FA is on, because neither lives in
the database; the file names both at the foot.

## The assistant connector

`supabase/functions/agent/index.ts` lets an assistant such as Claude work in
FollowUp on someone's behalf: look hospitals up, log and plan moments, keep contacts
and follow-up up to date, and answer questions about the agenda, the logbook and the
figures. It speaks the Model Context Protocol over plain JSON-RPC and is hand-written
for the same reason everything else is: one file, no imports, no packages. **It has
run against the development project only.** Nothing of it exists on the live project
yet.

Three rules it rests on:

- **Narrow tools, never the document.** The function reads, changes and writes; the
  model only names a hospital and a field. A language model must not carry hundreds
  of records back and forth.
- **The signed-in user's own token, never the service key.** It is passed unchanged
  to `read_state()` and `write_state()`, so the role, the product wall, the stamp and
  the cap on deletions apply exactly as in the app. `controle.sql` therefore still
  says everything there is to say about what an assistant can reach.
- **The rules now exist in a third place.** What a contact moment does to the colour
  and the stage (`autoStatus`, `stageStatus`, `syncPipeline`, `syncRooms`), the
  order of planned moments (`byWhen`, `tickOffDate`), the fixed lists and the type
  rules (`typesFor`, `typesAmong`, `shared`) and the counting rules (`units`,
  `rooms`, `signedRooms`) live in `domain.js` and are copied into the function.
  Change one in `domain.js` and it must change there too. `tests/` runs the same
  moments, plans and figures through both and fails when they disagree. If the connector stays, these belong in the database, where the app and the
  assistant would share them and `controle.sql` could check them (issue #21).

Signing in goes through Supabase Auth acting as an OAuth server. In the dashboard:
OAuth Server on, authorization path `/consent.html`, dynamic client registration off,
and one hand-registered public client for Claude with both
`https://claude.ai/api/mcp/auth_callback` and the `claude.com` variant as redirect
URIs. Supabase sends the user to `public/consent.html`, which reuses the app's
session in that browser — hence the "not you?" link — and loads a newer supabase-js
than `index.html`, because only that one knows `auth.oauth`. The function is deployed
by pasting it into the dashboard's editor (there is no CLI here), with **Verify JWT
off**: an assistant without a token must get the function's own 401, which says where
to sign in. The token is still checked on every call, and a failure to check it
answers 503 and not 401 — a 401 makes the assistant throw its token away.

Free text reaches a language model, and that is the connector's own kind of risk.
Names, notes and addresses are written by every colleague, across the product wall
and whatever their role, so a note could be phrased as an instruction to somebody
else's assistant. Every result that carries such text says it is data
(`NOT_INSTRUCTIONS`), the tools that overwrite are marked destructive so the
assistant asks first, and `docs/agent-instructions.md` says the same. None of that
is a lock. What holds regardless is the database: a `contributor` cannot remove, and
nobody reaches another product.

Arguments are checked against each tool's own schema before the tool runs
(`checkArgs()`): known names only, the right kind, text of at most 4,000
characters. Stored product names are looked up with `rowOf()`, never through the
prototype.

The assistant's key is the user's own sign-in, so on its own it could do whatever
the app can. Two things are therefore closed to it in the database
(`followup.via_assistant()`, which recognises the `client_id` a Supabase OAuth
token carries): managing users and restoring a backup. `whoami` reports whether the
key is recognised that way. Even so, do not connect an `admin` account on the live
project.

The consent page always shows who is asking and under which account, also when
consent was given before, and only continues on a click: on a shared browser a
remembered consent would otherwise hand a second person the first one's account
without a single screen.

The same function runs on both projects with the same tools under the same names,
so from inside a chat the two connectors cannot be told apart. The function
therefore knows the live project by name (`LIVE`, as `config.js` does): `whoami`
reports `database` on either side, and on development every answer, the server's
title and its instructions say that it is development. On live nothing is added,
so someone who only has the live connector never hears about it. A second live
project would have to be named there too, or it would call itself development.

Removing a record always takes two calls: the first returns what would go and a
code, the second removes. The code is tied to the user, the record and the document's
timestamp. It forces the two steps; it cannot prove a person said yes, and in Claude's
Auto mode nothing else does either. The real limit is the database's: a `contributor`
cannot remove anything, which is the role to give anyone who only dictates.

Open at the time of writing: the first connection dropped within forty minutes and
the cause was not found, so whether the token renews by itself after an hour is
unproven; and signing out of the app ends every session of that account, which as
far as we know includes the assistant's.

## The calendar feed

Someone can subscribe to the agenda from Outlook, Google or Apple: "Abonneren" on
the agenda's planned tab makes an address that the calendar app fetches by itself.
One way only — the calendar shows, planning stays here. A planned moment becomes an
event with the type, product and hospital as its title, the hospital's name and
address as the location, and the note; with a `time` it lasts an hour, without one
it is a whole day. No contact person: that is a clinician's name in a third
party's calendar, on lock screens. A single moment can also be downloaded as a
file (`public/ics.js`), which is a copy that does not follow changes.

- **The address is the key.** A calendar app signs in as nobody, so the address
  carries a 64-hex secret. `public.calendar_feeds` keeps only its SHA-256, so the
  app shows it once, at creation. The table is revoked and has RLS with no
  policy; everything goes through `feed_create()`, `feed_list()`,
  `feed_remove()` (owner or admin) and `calendar_feed()`, the only function
  `anon` may execute. Not through the assistant's key: `feed_create()` refuses
  `via_assistant()`.
- **The wall is the owner's, as it stands now.** `followup.feed_events()` runs
  the stored document through `scope_doc()` with the owner's current
  `app_users.products`, then narrows by the subscription's own choice ("planned
  for me" follows `assigneeOf()`; a product choice leaves out moments without a
  product). Narrowing someone's products narrows their feeds at the next fetch.
  It is pure, so `controle.sql` checks it on a literal document (60–66).
- **A subscription belongs to an account**: `owner` references `app_users` with
  `on delete cascade`, which itself cascades from `auth.users`. An admin sees
  and stops every subscription at the foot of the users screen. **Banning** an
  account in Supabase Auth or resetting its password does **not** stop its
  feeds: the address needs no sign-in. When someone leaves, stop their
  subscriptions on the users screen, or delete the account.
- **Managed by a person.** `feed_create()`, `feed_list()` and `feed_remove()` all
  refuse an assistant's key (`via_assistant()`), and `feed_create()` takes an
  advisory lock so two simultaneous calls cannot pass the cap of ten together.
- **What reaches the calendar is escaped, or reduced.** Every text property
  goes through `text()`; the record id, which sits in `UID`, is cut down to
  letters, digits, `-` and `_` (`uidOf()`), because anyone who can write can put
  any string there, and `check_payload()` refuses an id with a control
  character. Countries and types are looked up with `Object.hasOwn`, never
  through the prototype. `tests/agenda.mjs` keeps both.
- **The Edge Function** `supabase/functions/calendar/index.ts` turns
  `calendar_feed()` into `text/calendar`. It runs with the public key and no
  service key, needs **Verify JWT off** (a calendar sends no token), answers 404
  for an unknown or stopped address and 503 when the database fails, because a
  404 makes some calendars drop the subscription. It holds a copy of `ics.js`
  and of the type labels in both languages; the language is chosen per
  subscription.
- **From thirty days back onwards**, so an overdue moment stays until ticked off.
  The logbook is not in the feed, and neither is a planned moment without a date.
- **It is not instant**: Apple lets you choose, Outlook takes hours, Google up to
  a day. The dialog says so.

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

- **One JSON document, with an `updated_at` check per document.** The database
  still refuses a save when anyone saved in between, whatever they touched. The app
  no longer passes that on to the user: on a refused save it fetches the current
  document, lays the local change on top (`merge3()` in `public/domain.js`, driven by
  `pull()` in `app.js`) and saves again. Only when both sides changed the *same* field
  of the same record differently does the banner appear, and that person redoes one
  change. Three things keep this safe and must stay: `store.peek()` reads without
  adopting the new timestamp and `store.accept()` adopts it only after a successful
  merge (adopting first and failing to merge would let a stale document overwrite a
  colleague's work); a changed role or scope is never merged, only reloaded; and an
  import is never merged, since it replaces everything on purpose — a failed import
  clears the base, so nothing merges until a reload. Three things the merge decides
  per hospital rather than per field (`settleHospital()`): the colour and stage are
  only skipped as derived while a product is ticked, since without one they are set
  by hand; installed rooms are a counter, so two installations logged at once add
  up, but only when each side's change is explained by its own contact moments; and
  of two newly chosen main contacts the saver's stays. Stamps never count as a
  change. The merge is in
  the browser, not in the database, so the check per hospital that would make this a
  property of the data itself is still not there.
- **The app refreshes itself quietly.** When the tab regains focus, and every thirty
  seconds while it is open, it asks `state_version()` whether anything was saved and
  merges it in if so. Not while a dialog is open or a save is under way. The function
  returns a timestamp and nothing else, so it needs no wall; if it is missing from the
  database the app simply behaves as before.
- **"No importing" stops a deletion, not a rewrite.** `mode` comes from the client, so
  a `contributor` with the developer console can send an old backup as an ordinary save:
  if no id disappears, the inventory lets it through and every field is rolled back
  anyway. The inventory is the real line; the import flag is about shape, not intent.
- **Restoring a backup is a dashboard job.** `app_state_backups` is revoked from
  `authenticated`, because it holds the full unscoped document and would have been a
  door next to the wall.
- **Tests only for the copies.** `tests/` holds plain Node assertions, no framework
  and no packages (see Checking the copies). They check that rules kept in more than one
  place still agree, not the app as a whole.
- **`app.js` is large** for a single file. Splitting it is reasonable eventually, but
  there is no module bundler and no appetite for one, so it stays until the pain is real.
