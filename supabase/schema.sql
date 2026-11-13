-- FollowUp Prion – databank in Supabase
-- Plak dit in Supabase → SQL Editor → New query → Run.
-- Het script is herhaalbaar: opnieuw uitvoeren doet geen kwaad.
--
-- Drie lagen, in deze volgorde:
--   1. het document zelf en de dagelijkse kopie
--   2. wie er is en wat die mag (app_users)
--   3. read_state() en write_state(): de enige weg naar het document, en de
--      plaats waar de productafscherming echt gebeurt.

-- ---------------------------------------------------------------------------
-- 1. Het document
-- ---------------------------------------------------------------------------

-- Alle data van de app (ziekenhuizen, contacten, contactmomenten,
-- gegevens van de endoscopie-afdeling) staat als één JSON-document.
create table if not exists public.app_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- Dagelijkse kopie van het document, zodat je altijd kan terugkeren. De kopie
-- van een dag is de toestand bij de eerste wijziging van die dag.
create table if not exists public.app_state_backups (
  id          text not null,
  day         date not null default current_date,
  data        jsonb not null,
  saved_at    timestamptz not null default now(),
  primary key (id, day)
);

create or replace function public.backup_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Bewaar de toestand van vóór de eerste wijziging van vandaag en laat die
  -- staan. Met "do update" overschreef een verkeerde of kwaadwillige opslag ook
  -- de kopie van vandaag, en bleef er enkel die van gisteren over.
  --
  -- old bestaat niet bij een insert. Daarom twee takken en geen case-expressie:
  -- in één expressie wordt old.data toch aangeraakt en loopt de eerste opslag
  -- in een nieuw project mis.
  if tg_op = 'UPDATE' then
    insert into public.app_state_backups (id, day, data, saved_at)
    values (new.id, current_date, old.data, now())
    on conflict (id, day) do nothing;
  else
    insert into public.app_state_backups (id, day, data, saved_at)
    values (new.id, current_date, new.data, now())
    on conflict (id, day) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists app_state_backup on public.app_state;
create trigger app_state_backup
  after insert or update on public.app_state
  for each row execute function public.backup_app_state();

-- updated_by stond alleen als kolomstandaard ingesteld, en die werkt enkel bij
-- een insert. Na de eerste opslag bleef er dus eeuwig staan wie de rij had
-- aangemaakt. Deze trigger zet hem bij elke opslag op wie er aan het werk was.
create or replace function public.stamp_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists app_state_stamp on public.app_state;
create trigger app_state_stamp
  before insert or update on public.app_state
  for each row execute function public.stamp_app_state();


-- ---------------------------------------------------------------------------
-- 2. Gebruikers en rollen
-- ---------------------------------------------------------------------------

-- De rekenhulpjes van dit script staan in een apart schema. Alles wat in
-- "public" staat, maakt PostgREST namelijk vanzelf een /rpc/-adres van, en dat
-- willen we enkel voor read_state() en write_state(). Dit schema krijgt nooit
-- "usage", dus van buitenaf bestaat het niet.
create schema if not exists followup;

-- Eén rij per gebruiker, naast auth.users. Dat laatste is van Supabase en raken
-- we niet aan; hier staat wat de app zelf van een gebruiker moet weten.
--
-- De naam staat hier omdat de app hem naast een contactmoment zet: auth.users
-- kent alleen een e-mailadres, en "wie heeft dit gebeld" leest beter met een
-- naam dan met een adres.
--
-- products is het bereik: welke producten deze gebruiker mag zien en bewerken.
-- Een lege lijst betekent onbeperkt — alle producten. Iemand beperken tot
-- niéts heeft geen zin, dus die betekenis stond vrij.
--
-- De rollen:
--   admin        alles, en mag rollen toekennen
--   editor       alles met de data, ook verwijderen en een back-up importeren
--   contributor  toevoegen en wijzigen, niet verwijderen, niet importeren
--   viewer       alleen lezen, afdrukken en exporteren
create table if not exists public.app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  role        text not null default 'viewer'
                check (role in ('admin', 'editor', 'contributor', 'viewer')),
  products    text[] not null default '{}',
  updated_at  timestamptz not null default now()
);

-- Aanmelden staat uit op dit project: gebruikers maak je met de hand onder
-- Authentication → Users. Deze trigger geeft zo iemand meteen een rij met de
-- laagste rechten, zodat een nieuwe gebruiker nooit per ongeluk meer mag dan
-- bedoeld. De beheerder promoveert hem daarna in de app zelf.
--
-- Houd deze functie triviaal: wat hier mislukt, laat het aanmaken van de
-- gebruiker in het dashboard mislukken.
create or replace function public.new_app_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_users (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists app_user_create on auth.users;
create trigger app_user_create
  after insert on auth.users
  for each row execute function public.new_app_user();

-- Gebruikers die er al waren krijgen ook een rij — de trigger hierboven kijkt
-- alleen naar wie er nieuw bijkomt.
insert into public.app_users (id)
select id from auth.users
on conflict (id) do nothing;

-- En er moet een beheerder zijn, anders kan niemand nog een rol toekennen en
-- staat iedereen buiten. Is er nog geen enkele, dan wordt de oudste gebruiker
-- het. Dit gebeurt dus alleen de eerste keer dat dit script loopt.
update public.app_users set role = 'admin'
where id = (select id from auth.users order by created_at limit 1)
  and not exists (select 1 from public.app_users where role = 'admin');

-- Mijn rol en mijn bereik, als één plaats waar de rest naar kijkt.
--
-- security definer is hier geen luxe maar noodzaak: een policy op app_users die
-- zelf app_users moet lezen, draait anders in zichzelf rond. Een functie van de
-- eigenaar omzeilt de rij-beveiliging en breekt die lus.
--
-- Geen rij? Dan viewer. Dat is de veilige kant om op te vallen: lezen mag nog,
-- schrijven niet. Let op in de SQL-editor: daar is auth.uid() leeg en ben je
-- dus ook viewer.
create or replace function followup.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.app_users where id = auth.uid()), 'viewer');
$$;

create or replace function followup.my_products() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select products from public.app_users where id = auth.uid()), '{}');
$$;

-- Deze staat wel in public: de policies op app_users hebben hem nodig, en een
-- policy kan niet bij een schema waar de aanroeper geen usage op heeft.
-- Komt deze oproep van een assistent? Wie de koppeling toestaat, geeft de
-- assistent een sleutel die voor de databank dezelfde gebruiker is. De
-- koppeling zelf biedt maar een handvol werktuigen aan, maar de sleutel kan
-- meer: lekt hij, dan kon hij alles wat de app kan. Een sleutel die via de
-- OAuth-server van Supabase is uitgegeven draagt het id van de aanvrager
-- (client_id); een gewone aanmelding in de app heeft dat niet. Twee dingen
-- zijn daarom alleen in de app zelf te doen: gebruikers beheren en een
-- back-up terugzetten.
create or replace function followup.via_assistant() returns boolean
language sql stable set search_path = public as $$
  select coalesce(auth.jwt() ->> 'client_id', '') <> '';
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select followup.my_role() = 'admin' and not followup.via_assistant();
$$;

-- Er moet altijd minstens één beheerder overblijven. Zonder deze controle kan
-- de laatste admin zichzelf degraderen en is het Supabase-dashboard de enige
-- weg terug. Deze trigger houdt ook updated_at bij, zodat de app niet elke
-- keer zelf aan die kolom moet denken.
create or replace function public.guard_app_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if old.role = 'admin' and new.role <> 'admin'
     and not exists (select 1 from public.app_users
                     where role = 'admin' and id <> old.id) then
    raise exception 'laatste beheerder' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists app_user_guard on public.app_users;
create trigger app_user_guard
  before update on public.app_users
  for each row execute function public.guard_app_user();


-- ---------------------------------------------------------------------------
-- 3. Rekenhulpjes op jsonb
-- ---------------------------------------------------------------------------
-- Allemaal puur: jsonb erin, jsonb eruit, geen tabel in de buurt. Daarom
-- immutable, en daarom kan je ze stuk voor stuk nakijken met een gewone select
-- (zie supabase/controle.sql). Het samenvoegen hangt hiervan af, en een fout
-- daarin beschadigt data bij élke opslag — dus hoe kleiner het stuk, hoe beter
-- het te controleren valt.

create or replace function followup.arr(v jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end;
$$;

create or replace function followup.obj(v jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'object' then v else '{}'::jsonb end;
$$;

create or replace function followup.texts(v jsonb) returns text[]
language sql immutable set search_path = public as $$
  select coalesce((
    select array_agg(t.e #>> '{}')
      from jsonb_array_elements(followup.arr(v)) t(e)
     where jsonb_typeof(t.e) = 'string'
  ), '{}'::text[]);
$$;

-- De productenlijst, in dezelfde volgorde als PRODUCTS in public/domain.js.
-- Twee plaatsen dus, en dat is niet te vermijden: de databank kan dat bestand
-- niet lezen. Dit is wél de enige plaats aan deze kant — komt er een product
-- bij, dan volstaat deze functie.
--
-- Ze bepaalt alleen de volgorde, niet wat toegelaten is. Een product dat hier
-- niet in staat wordt niet geweigerd maar sorteert achteraan, zodat een app
-- die al een nieuw product kent niet stukloopt op een databank die nog niet
-- bijgewerkt is.
create or replace function followup.producten() returns text[]
language sql immutable set search_path = public as $$
  select array['EndoQ', 'Ainex', 'Thyroid RFA', 'Fibroid RFA', 'Stents'];
$$;

-- De vaste volgorde uit domain.js. Die houden we aan zodat laden-en-opslaan
-- zonder wijziging exact hetzelfde document teruggeeft; net dát maakt de
-- belangrijkste controle mogelijk ("is er niets veranderd?"). Wat we niet
-- kennen komt achteraan in plaats van weg te vallen.
create or replace function followup.product_sort(v text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce((
    select array_agg(q.x order by coalesce(array_position(followup.producten(), q.x), 99), q.x)
      from (select distinct unnest(v) as x) q
  ), '{}'::text[]);
$$;

create or replace function followup.only_in(a text[], b text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce((select array_agg(distinct x) from unnest(a) x where x <> all(b)), '{}'::text[]);
$$;

create or replace function followup.both_in(a text[], b text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce((select array_agg(distinct x) from unnest(a) x where x = any(b)), '{}'::text[]);
$$;

-- Een regel zonder product blijft voor iedereen zichtbaar. Dat is bewust: de
-- meeste contactmomenten van vóór deze afscherming hebben geen product, en een
-- geschiedenis met gaten erin is erger dan een regel te veel zien.
--
-- Twee vormen. Een contactmoment en een gepland moment dragen meestal één
-- product in "product"; een contactpersoon draagt er meerdere in "products",
-- want dezelfde arts is vaak het aanspreekpunt voor allebei. Sinds een gesprek
-- over twee producten tegelijk kan gaan, mag ook een moment die lijst dragen.
-- Bij een lijst volstaat één overlapping: wie Ainex mag, ziet de arts die
-- EndoQ én Ainex doet, en het gesprek dat over allebei ging.
create or replace function followup.in_scope(e jsonb, allowed text[]) returns boolean
language sql immutable set search_path = public as $$
  select case
    when e ? 'products'
      then followup.texts(e -> 'products') = '{}'::text[]
        or followup.both_in(followup.texts(e -> 'products'), allowed) <> '{}'::text[]
    else coalesce(e ->> 'product', '') = '' or coalesce(e ->> 'product', '') = any(allowed)
  end;
$$;

-- (opgeslagen \ bereik) ∪ (payload ∩ bereik). Zo kan een beperkte opslag nooit
-- het product van de collega wegnemen, en beslist de gebruiker wel volledig
-- over het zijne. Geldt voor het ziekenhuis én voor een contactpersoon: allebei
-- dragen een lijst producten die twee mensen samen invullen.
create or replace function followup.merge_products(stored jsonb, incoming jsonb,
                                                   allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select to_jsonb(followup.product_sort(
           followup.only_in(followup.texts(stored   -> 'products'), allowed)
        || followup.both_in(followup.texts(incoming -> 'products'), allowed)));
$$;

-- Zit er in dit ziekenhuis iets van een product dat jij niet mag? Sinds elk
-- ziekenhuis voor iedereen zichtbaar is, is dit wat een verwijdering tegenhoudt:
-- het vinkje alleen volstaat niet, want een ziekenhuis zonder vinkje kan best
-- contactmomenten van de collega bevatten. Weggooien wat je nooit gezien hebt,
-- kan niet.
create or replace function followup.vreemde_data(h jsonb, allowed text[]) returns boolean
language sql immutable set search_path = public as $$
  select exists (
    select 1
      from unnest(array['contacts', 'activities', 'planned']) as k(lijst),
           jsonb_array_elements(followup.arr(h -> k.lijst)) t(e)
     where not followup.in_scope(t.e, allowed))
  -- De opvolging van een product dat jij niet mag is evengoed werk van een
  -- collega: een fase, een kleur, een verantwoordelijke.
  or exists (
    select 1 from jsonb_object_keys(followup.obj(h -> 'pipeline')) k(product)
     where k.product <> all(allowed));
$$;

-- ---------------------------------------------------------------------------
-- De opvolging per product
-- ---------------------------------------------------------------------------
-- h.pipeline is een object met per product een fase, een kleur en een
-- verantwoordelijke. Het valt binnen de muur zoals een contactmoment: wie
-- enkel Ainex mag, krijgt enkel de Ainex-rij en beslist enkel over die rij.
--
-- h.status en h.stage op het ziekenhuis zelf zijn daarvan afgeleid — het
-- product dat het verst staat — en dus net als nextAction iets wat we zelf
-- uitrekenen, bij het lezen én bij het schrijven. Bij het lezen omdat "groen,
-- klant" anders verklapt hoe ver het andere product staat. Bij het schrijven
-- omdat een afgeschermde browser dat geheel uitrekent op de helft die hij
-- ziet.
--
-- Een document zonder pipeline blijft onaangeroerd: geen sleutel erbij, geen
-- kleur herrekend. Anders gaf laden en opslaan een ander document terug.

-- De fases, in dezelfde volgorde als STAGES in public/domain.js. Net als
-- producten(): twee plaatsen, omdat de databank dat bestand niet kan lezen.
create or replace function followup.fases() returns text[]
language sql immutable set search_path = public as $$
  select array['prospect', 'first_contact', 'meeting', 'demo_planned', 'demo_installed',
               'evaluation', 'purchasing', 'customer', 'on_hold', 'not_interested'];
$$;

create or replace function followup.scope_pipeline(p jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_object_agg(k.key, k.value)
      from jsonb_each(followup.obj(p)) k
     where k.key = any(allowed)
  ), '{}'::jsonb);
$$;

-- Dezelfde formule als bij de vinkjes: (opgeslagen \ bereik) ∪ (payload ∩ bereik).
create or replace function followup.merge_pipeline(stored jsonb, incoming jsonb,
                                                   allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
           select jsonb_object_agg(k.key, k.value)
             from jsonb_each(followup.obj(stored)) k
            where k.key <> all(allowed)), '{}'::jsonb)
      || followup.scope_pipeline(incoming, allowed);
$$;

-- Hangt de kleur van dit ziekenhuis aan een opvolging per product? Dan is ze
-- afgeleid, en mogen we ze niet doorgeven aan wie die producten niet ziet.
create or replace function followup.heeft_opvolging(h jsonb) returns boolean
language sql immutable set search_path = public as $$
  select exists (
    select 1 from unnest(followup.texts(h -> 'products')) p(x)
     where jsonb_typeof(h -> 'pipeline' -> p.x) = 'object');
$$;

-- status en stage van het ziekenhuis: die van het product dat het verst
-- staat. Zelfde regel als furthest() in domain.js — eerst de kleur, dan de
-- fase, en on hold of niet geïnteresseerd achter prospect. Alleen de
-- producten die aangevinkt staan tellen mee.
--
-- Is er voor geen enkel aangevinkt product een opvolging, dan hangt het van
-- "afgeleid" af: was de kleur afgeleid van wat we net hebben weggehaald, dan
-- wordt het "nog geen contact"; anders is het de losse kleur van een
-- ziekenhuis waar nog geen product aan hangt, en die blijft staan.
create or replace function followup.fix_overall(h jsonb, afgeleid boolean) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when b.e is not null then h || jsonb_build_object(
           'status', coalesce(b.e -> 'status', '"red"'::jsonb),
           'stage',  coalesce(b.e -> 'stage',  '"prospect"'::jsonb))
    when afgeleid then h || '{"status": "red", "stage": "prospect"}'::jsonb
    else h end
  from (select 1) een
  left join lateral (
    select h -> 'pipeline' -> p.x as e
      from unnest(followup.texts(h -> 'products')) with ordinality p(x, i)
     where jsonb_typeof(h -> 'pipeline' -> p.x) = 'object'
     order by coalesce(array_position(array['red', 'orange', 'green'], h -> 'pipeline' -> p.x ->> 'status'), 1) desc,
              case when h -> 'pipeline' -> p.x ->> 'stage' in ('on_hold', 'not_interested') then -1
                   else coalesce(array_position(followup.fases(), h -> 'pipeline' -> p.x ->> 'stage'), 1) end desc,
              p.i
     limit 1
  ) b on true;
$$;


-- nextAction en nextActionDate volgen uit planned[0]. Zou een beperkte
-- gebruiker ze zelf schrijven, dan stond zijn volgende actie in een veld dat
-- ook de collega van het andere product en de CSV-export lezen. Zelfde regel
-- als syncNextAction() in de app: sorteren op datum, momenten zonder datum
-- vallen weg, dan het eerste.
--
-- Draait ook bij het afschermen, en daar is het meer dan opruimen:
-- nextAction is de nota van het eerste geplande moment, en dat kan er een
-- van het andere product zijn. Zonder deze herberekening stuurden we die
-- tekst mee naar een browser die het moment zelf niet mag zien.
create or replace function followup.fix_planned(h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  with p as (
    select coalesce((
      select jsonb_agg(t.e order by (t.e ->> 'date'), t.i)
        from jsonb_array_elements(followup.arr(h -> 'planned')) with ordinality t(e, i)
       where coalesce(t.e ->> 'date', '') <> ''
    ), '[]'::jsonb) as lijst
  )
  select h || jsonb_build_object(
           'planned',        p.lijst,
           'nextActionDate', coalesce(p.lijst -> 0 ->> 'date', ''),
           'nextAction',     coalesce(p.lijst -> 0 ->> 'note', ''))
    from p;
$$;


-- ---------------------------------------------------------------------------
-- 4. Afschermen bij het lezen
-- ---------------------------------------------------------------------------

-- Contactmomenten en geplande momenten. Draagt een moment een productlijst
-- (een gesprek over twee producten tegelijk), dan gaat die gesnoeid mee, net
-- als bij een contactpersoon hieronder: het moment blijft zichtbaar zodra er
-- één product overlapt, maar het product van de collega staat er niet bij.
-- De nota is gedeeld, zoals de velden van een contactpersoon dat zijn. Een
-- moment in de oude vorm, met één "product", gaat ongemoeid mee.
create or replace function followup.scope_entries(entries jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(case when t.e ? 'products'
                          then t.e || jsonb_build_object('products',
                                 to_jsonb(followup.product_sort(
                                   followup.both_in(followup.texts(t.e -> 'products'), allowed))))
                          else t.e end order by t.i)
      from jsonb_array_elements(followup.arr(entries)) with ordinality t(e, i)
     where followup.in_scope(t.e, allowed)
  ), '[]'::jsonb);
$$;

-- Contactpersonen, met hun productlijst mee afgeschermd. Dezelfde reden als bij
-- het ziekenhuis: een Ainex-gebruiker die het EndoQ-vinkje van een arts ziet
-- staan, leest daaruit af dat de collega met die arts bezig is, en hij zou het
-- kunnen uitzetten ook. Zichtbaar blijft de arts wel — één overlapping volstaat.
-- Een contactpersoon die het oude "product" nog draagt, gaat ongemoeid mee.
-- Niet uit beleefdheid: zou hij hier omgezet worden, dan gaf laden-en-opslaan
-- een ander document terug dan er stond, en dat is precies wat controle 8
-- bewaakt. De omzetting hoort in normalize() in de app, zoals demoDate destijds.
-- Hij wordt wel correct afgeschermd — in_scope() leest beide vormen.
create or replace function followup.scope_contacts(entries jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(case when t.e ? 'products'
                          then t.e || jsonb_build_object('products',
                                 to_jsonb(followup.product_sort(
                                   followup.both_in(followup.texts(t.e -> 'products'), allowed))))
                          else t.e end order by t.i)
      from jsonb_array_elements(followup.arr(entries)) with ordinality t(e, i)
     where followup.in_scope(t.e, allowed)
  ), '[]'::jsonb);
$$;

-- h.products wordt mee afgeschermd: anders ziet een Ainex-gebruiker een
-- EndoQ-vinkje staan dat hij niet mag aan- of uitzetten. En fix_planned()
-- erover, zodat nextAction de nota van zijn eigen eerste geplande moment is
-- en niet die van het moment dat we er net hebben uitgehaald.
create or replace function followup.scope_hospital(h jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select followup.fix_overall(followup.fix_planned(h || jsonb_build_object(
    'products',   to_jsonb(followup.product_sort(followup.both_in(followup.texts(h -> 'products'), allowed))),
    'contacts',   followup.scope_contacts(h -> 'contacts', allowed),
    'activities', followup.scope_entries(h -> 'activities', allowed),
    'planned',    followup.scope_entries(h -> 'planned', allowed))
    -- De opvolging van de andere producten gaat niet mee, en de kleur van het
    -- ziekenhuis wordt herrekend op wat overblijft.
    || case when h ? 'pipeline'
            then jsonb_build_object('pipeline', followup.scope_pipeline(h -> 'pipeline', allowed))
            else '{}'::jsonb end),
    followup.heeft_opvolging(h));
$$;

create or replace function followup.scope_targets(targets jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_object_agg(y.key, coalesce((
             select jsonb_object_agg(p.key, p.value)
               from jsonb_each(followup.obj(y.value)) p
              where p.key = any(allowed)
           ), '{}'::jsonb))
      from jsonb_each(followup.obj(targets)) y
  ), '{}'::jsonb);
$$;

-- Het hele document, afgeschermd. Elk ziekenhuis blijft staan, voor iedereen:
-- de muur zit rond de gegevens, niet rond het ziekenhuis. Wie enkel Ainex mag,
-- ziet dus de volledige lijst en de volledige kaart, maar binnen een
-- ziekenhuis enkel de Ainex-contactpersonen, -contactmomenten en -planning, en
-- enkel het Ainex-vinkje. Een ziekenhuis waar nog niets aan hangt is daarmee
-- gewoon een prospect die iedereen ziet. Sleutels die wij niet kennen
-- blijven staan: we vertrekken van het document zelf en vervangen enkel
-- wat we wél begrijpen.
create or replace function followup.scope_doc(doc jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when allowed is null or allowed = '{}'::text[] then doc
    else doc
      || case when doc ? 'targets'
              then jsonb_build_object('targets', followup.scope_targets(doc -> 'targets', allowed))
              else '{}'::jsonb end
      || jsonb_build_object('hospitals', coalesce((
           select jsonb_agg(followup.scope_hospital(t.e, allowed) order by t.i)
             from jsonb_array_elements(followup.arr(doc -> 'hospitals')) with ordinality t(e, i)
         ), '[]'::jsonb))
  end;
$$;


-- ---------------------------------------------------------------------------
-- 5. De inventaris: wat heeft een id
-- ---------------------------------------------------------------------------
-- Eén sleutel per record, met het ziekenhuis erbij. Daarmee ziet write_state()
-- wát er verdwenen is in plaats van enkel dát er iets weg is — het verschil
-- tussen een bruikbare melding en "opslaan mislukt".
--
-- Twee dingen tellen bewust niet mee:
--  * een record zonder id. Dat is niet te volgen, en normalize() in de app
--    geeft het bij het laden een nieuw id — dan leek elke eerste opslag na zo'n
--    document op een verwijdering.
--  * een gepland moment zonder datum. Dat is geen planning; normalize() gooit
--    het bij het laden weg, dus wij rekenen het ook niet mee. Zonder deze
--    uitzondering kon een contributor zo'n document nooit meer opslaan.
create or replace function followup.doc_keys(doc jsonb) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(k), '{}'::text[]) from (
    select 'h:' || (t.e ->> 'id') as k
      from jsonb_array_elements(followup.arr(doc -> 'hospitals')) t(e)
     where coalesce(t.e ->> 'id', '') <> ''
    union all
    select a.tag || ':' || (t.e ->> 'id') || ':' || (c.e ->> 'id')
      from jsonb_array_elements(followup.arr(doc -> 'hospitals')) t(e)
      cross join (values ('c', 'contacts'), ('a', 'activities'), ('p', 'planned')) as a(tag, arr)
      cross join lateral jsonb_array_elements(followup.arr(t.e -> a.arr)) c(e)
     where coalesce(t.e ->> 'id', '') <> ''
       and coalesce(c.e ->> 'id', '') <> ''
       and (a.tag <> 'p' or coalesce(c.e ->> 'date', '') <> '')
  ) q;
$$;


-- ---------------------------------------------------------------------------
-- 6. De payload keuren vóór we er iets mee doen
-- ---------------------------------------------------------------------------
-- Een ontbrekende of verkeerd getypeerde lijst lezen we verderop als "leeg", en
-- dat is hetzelfde als "alles verwijderd". Daarom eerst de vorm.
create or replace function followup.check_payload(payload jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare
  v_n   int;
  v_bad text;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'followup:invalid_payload het document is geen JSON-object'
      using errcode = 'PT422', hint = 'invalid_payload';
  end if;
  if jsonb_typeof(payload -> 'hospitals') <> 'array' then
    raise exception 'followup:invalid_payload hospitals ontbreekt of is geen lijst'
      using errcode = 'PT422', hint = 'invalid_payload';
  end if;

  select count(*) into v_n
    from jsonb_array_elements(payload -> 'hospitals') t(e)
   where jsonb_typeof(t.e) <> 'object'
      or jsonb_typeof(t.e -> 'id') <> 'string'
      or t.e ->> 'id' = '';
  if v_n > 0 then
    raise exception 'followup:invalid_payload % ziekenhuis(zen) zonder geldig id', v_n
      using errcode = 'PT422', hint = 'invalid_payload';
  end if;

  -- contacts/activities/planned mogen ontbreken (oudere data, zie seed.json),
  -- maar als ze er staan moeten het lijsten zijn. Een object of een string
  -- zouden we verderop als een lege lijst lezen, en dan is elke regel weg.
  select count(*) into v_n
    from jsonb_array_elements(payload -> 'hospitals') t(e)
    cross join (values ('contacts'), ('activities'), ('planned')) as a(arr)
   where t.e ? a.arr and jsonb_typeof(t.e -> a.arr) <> 'array';
  if v_n > 0 then
    raise exception 'followup:invalid_payload contacts, activities en planned moeten lijsten zijn'
      using errcode = 'PT422', hint = 'invalid_payload';
  end if;

  select k into v_bad from unnest(followup.doc_keys(payload)) k
   group by k having count(*) > 1 limit 1;
  if v_bad is not null then
    raise exception 'followup:duplicate_id % staat twee keer in het document', v_bad
      using errcode = 'PT422', hint = 'duplicate_id',
            detail = 'Twee records met hetzelfde id maken het samenvoegen onbeslisbaar.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 7. Afgeleide velden rechtzetten
-- ---------------------------------------------------------------------------
-- Drie dingen rekent de app uit over h.activities of h.planned, en een beperkte
-- gebruiker heeft daar maar een deel van. Wat hij terugstuurt klopt dan wel
-- voor zijn eigen helft maar niet voor het geheel, dus rekenen we het hier
-- opnieuw uit over de volledige lijst.
--
-- nextAction en nextActionDate zijn de derde, maar fix_planned() staat
-- hierboven bij de rekenhulpjes: hij draait ook bij het afschermen en moest
-- dus vóór scope_hospital() gedefinieerd staan.
--
-- unit.roomsInstalled hoort hier niet bij: syncRooms() in de app past een
-- vérschil toe en geen som, dus een Ainex-gebruiker telt zijn eigen installatie
-- op bij het gedeelde getal en raakt dat van EndoQ niet.

-- roomsDemo is wél een herberekening in de app: het aantal van de laatste demo
-- met een aantal. Uit een gesnoeide lijst kwam dat van de laatste Ainex-demo,
-- en dat overschreef wat EndoQ er had staan.
--
-- Maar het veld staat ook met de hand in de fiche, en syncRooms() in de app
-- rekent alleen opnieuw als er een demo bij kwam, wegging of veranderde. Zouden
-- we hier altijd herrekenen, dan overschreef elke opslag een ingetypt getal.
-- Daarom eerst de vraag: zijn de demo's veranderd? Zo niet, dan blijft staan
-- wat de gebruiker er zelf heeft neergezet.
create or replace function followup.demo_set(h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('id', t.e -> 'id', 'date', t.e -> 'date',
                                        'rooms', t.e -> 'rooms') order by t.i)
      from jsonb_array_elements(followup.arr(h -> 'activities')) with ordinality t(e, i)
     where t.e ->> 'type' = 'demo'
  ), '[]'::jsonb);
$$;

-- De vorige versie van dit script had een variant met een argument. Die moet
-- weg: "create or replace" kan de argumentenlijst niet veranderen, en zonder
-- drop bestaan er twee.
drop function if exists followup.fix_rooms_demo(jsonb);

-- Dezelfde keuze als in de app bij twee demo's op dezelfde dag: die van de
-- laatste datum, en bij gelijke datum de eerste in de lijst (de sortering in
-- de app is stabiel).
create or replace function followup.fix_rooms_demo(stored jsonb, h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when followup.demo_set(stored) = followup.demo_set(h) then h
    else coalesce((
      select h || jsonb_build_object('unit',
               followup.obj(h -> 'unit') || jsonb_build_object('roomsDemo', t.e -> 'rooms'))
        from jsonb_array_elements(followup.arr(h -> 'activities')) with ordinality t(e, i)
       where t.e ->> 'type' = 'demo'
         and jsonb_typeof(t.e -> 'rooms') = 'number'
         and (t.e ->> 'rooms')::numeric <> 0
       order by (t.e ->> 'date') desc, t.i
       limit 1
    ), h)
  end;
$$;


-- ---------------------------------------------------------------------------
-- 8. De stempel: wie heeft dit ingevoerd
-- ---------------------------------------------------------------------------
-- De app vult createdBy zelf in, maar wat de browser stuurt is niet meer dan
-- een bewering. Daarom zet de databank het hier zelf, en wordt alles wat de
-- client meestuurde overschreven. Niet controleren maar toekennen: controleren
-- zou uitzonderingen nodig hebben (een import zet records van anderen terug,
-- oude records hebben geen auteur), en met uitzonderingen bewijst een controle
-- niets meer.
--
-- De regel is eenvoudig, en gaat enkel over contactmomenten en geplande
-- momenten — contactpersonen en ziekenhuizen dragen geen stempel:
--   id bestond nog niet          -> nieuw, dus van jou
--   id bestond, inhoud veranderd -> maker blijft, jij bent de laatste wijziger
--   id bestond, inhoud gelijk    -> alles blijft zoals het stond
create or replace function followup.bare(e jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select e - 'createdBy' - 'createdAt' - 'updatedBy' - 'updatedAt';
$$;

-- Enkel de stempelsleutels die er écht staan. Een record van vóór deze
-- wijziging heeft er geen, en dan mogen we ze er ook niet bij verzinnen: anders
-- verandert "laden en ongewijzigd opslaan" het document alsnog.
create or replace function followup.stamp_part(e jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((select jsonb_object_agg(k, e -> k)
                     from unnest(array['createdBy', 'createdAt', 'updatedBy', 'updatedAt']) k
                    where e ? k), '{}'::jsonb);
$$;

-- Merk op dat elke tak met followup.bare(t.e) begint: wat de browser aan
-- stempel meestuurde gaat er eerst af. Dat is het hele punt — toekennen, niet
-- controleren.
create or replace function followup.stamp_entries(stored jsonb, entries jsonb,
                                                  who text, day text) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(
             case
               when s.e is null
                 then followup.bare(t.e) || jsonb_build_object('createdBy', who, 'createdAt', day,
                                                               'updatedBy', who, 'updatedAt', day)
               when followup.bare(s.e) is distinct from followup.bare(t.e)
                 then followup.bare(t.e) || followup.stamp_part(s.e)
                        || jsonb_build_object('updatedBy', who, 'updatedAt', day)
               else followup.bare(t.e) || followup.stamp_part(s.e)
             end order by t.i)
      from jsonb_array_elements(followup.arr(entries)) with ordinality t(e, i)
      left join lateral (
        select x.e from jsonb_array_elements(followup.arr(stored)) x(e)
         where x.e ->> 'id' = t.e ->> 'id' limit 1
      ) s on true
  ), '[]'::jsonb);
$$;

create or replace function followup.stamp_doc(stored jsonb, doc jsonb,
                                              who text, day text) returns jsonb
language sql immutable set search_path = public as $$
  select doc || jsonb_build_object('hospitals', coalesce((
    -- Ontbreekt een lijst (seed.json heeft geen planned), dan laten we hem
    -- ontbreken in plaats van er een lege bij te zetten: stempelen mag niets
    -- aan de vórm van het document veranderen, alleen aan de stempels.
    select jsonb_agg(
             t.e
             || case when t.e ? 'activities'
                     then jsonb_build_object('activities',
                            followup.stamp_entries(s.e -> 'activities', t.e -> 'activities', who, day))
                     else '{}'::jsonb end
             || case when t.e ? 'planned'
                     then jsonb_build_object('planned',
                            followup.stamp_entries(s.e -> 'planned', t.e -> 'planned', who, day))
                     else '{}'::jsonb end
             order by t.i)
      from jsonb_array_elements(followup.arr(doc -> 'hospitals')) with ordinality t(e, i)
      left join lateral (
        select x.e from jsonb_array_elements(followup.arr(stored -> 'hospitals')) x(e)
         where x.e ->> 'id' = t.e ->> 'id' limit 1
      ) s on true
  ), '[]'::jsonb));
$$;


-- ---------------------------------------------------------------------------
-- 9. Samenvoegen
-- ---------------------------------------------------------------------------
-- Dit is het gevaarlijke stuk. Een beperkte gebruiker heeft maar een deel van
-- het document gezien, dus zijn opslag is maar een deel. We bouwen het nieuwe
-- document daarom altijd op vanuit wat er in de databank staat en vervangen
-- enkel de stukken die hij kón zien. Nooit andersom: een document dat van de
-- payload vertrekt, mist alles wat hij niet mocht zien.

create or replace function followup.merge_entries(stored jsonb, incoming jsonb,
                                                  allowed text[], wat text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare v_bad text;
begin
  -- Een product opsturen dat je niet mag, kan niet. De app hoort het ook niet
  -- aan te bieden. Stil negeren zou de wijziging van de gebruiker opeten, stil
  -- aanvaarden laat de regel bij zijn volgende laden verdwijnen.
  select t.e ->> 'id' into v_bad
    from jsonb_array_elements(followup.arr(incoming)) t(e)
   where not followup.in_scope(t.e, allowed)
   limit 1;
  if v_bad is not null then
    raise exception 'followup:out_of_scope % % hoort bij een product dat je niet mag', wat, v_bad
      using errcode = 'PT403', hint = 'out_of_scope';
  end if;

  -- Een id dat in de databank bij het andere product hoort, mag niet in de
  -- payload opduiken: na het samenvoegen stonden er dan twee records met
  -- hetzelfde id. In de praktijk een botsing van uid() of een gesleutelde
  -- payload — in beide gevallen niet stil doorlaten.
  select t.e ->> 'id' into v_bad
    from jsonb_array_elements(followup.arr(stored)) t(e)
   where not followup.in_scope(t.e, allowed)
     and exists (select 1 from jsonb_array_elements(followup.arr(incoming)) p(e)
                  where p.e ->> 'id' = t.e ->> 'id')
   limit 1;
  if v_bad is not null then
    raise exception 'followup:duplicate_id % % bestaat al bij het andere product', wat, v_bad
      using errcode = 'PT422', hint = 'duplicate_id';
  end if;

  -- Buiten het zicht: letterlijk uit de databank, op zijn oude plaats.
  -- Binnen het zicht en meegestuurd: de versie van de gebruiker, op dezelfde
  -- plaats. Nieuw: achteraan, zoals de app zelf ook toevoegt. Binnen het zicht
  -- en niet meegestuurd: verwijderd — write_state beslist of dat mocht.
  --
  -- Draagt het record een productlijst — een contactpersoon, of een moment
  -- over meer dan één product — dan gaat die door dezelfde formule als bij het ziekenhuis in plaats van
  -- rechtstreeks uit de payload te komen. We kijken naar de vorm van het
  -- record en niet naar welke lijst het is: zo klopt het ook als er later nog
  -- een soort bijkomt.
  return coalesce((
    with s as (select t.e, t.i from jsonb_array_elements(followup.arr(stored))   with ordinality t(e, i)),
         p as (select t.e, t.i from jsonb_array_elements(followup.arr(incoming)) with ordinality t(e, i))
    select jsonb_agg(q.e order by q.groep, q.i) from (
      select s.e, 0 as groep, s.i from s where not followup.in_scope(s.e, allowed)
      union all
      select case when s.e ? 'products' or p.e ? 'products'
                  then p.e || jsonb_build_object('products', followup.merge_products(s.e, p.e, allowed))
                  else p.e end, 0, s.i
        from s join p on p.e ->> 'id' = s.e ->> 'id'
       where followup.in_scope(s.e, allowed)
      union all
      select case when p.e ? 'products'
                  then p.e || jsonb_build_object('products', followup.merge_products('{}'::jsonb, p.e, allowed))
                  else p.e end, 1, p.i
        from p
       where not exists (select 1 from s where s.e ->> 'id' = p.e ->> 'id')
    ) q
  ), '[]'::jsonb);
end $$;

-- Eén ziekenhuis. De gewone velden en unit komen uit de payload: dat is een
-- bewuste keuze. Een Ainex-gebruiker die het adres of het aantal kamers
-- verbetert, deelt dat met de EndoQ-collega — samen werken, geen lek.
--
-- products is het enige veld met een eigen formule: wat het andere product
-- gebruikt blijft staan, en enkel over zijn eigen producten beslist de
-- gebruiker. Anders kon een beperkte opslag het vinkje van het andere product
-- weghalen, en daarmee het ziekenhuis uit de filters, de statistieken en de
-- productkeuze van de collega.
create or replace function followup.merge_hospital(stored jsonb, incoming jsonb,
                                                   allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select followup.fix_overall(followup.fix_rooms_demo(stored, followup.fix_planned(
    incoming || jsonb_build_object(
      'products', followup.merge_products(stored, incoming, allowed),
      'contacts',   followup.merge_entries(stored -> 'contacts',   incoming -> 'contacts',   allowed, 'contactpersoon'),
      'activities', followup.merge_entries(stored -> 'activities', incoming -> 'activities', allowed, 'contactmoment'),
      'planned',    followup.merge_entries(stored -> 'planned',    incoming -> 'planned',    allowed, 'gepland moment'))
    -- De opvolging per product: de rij van de collega blijft zoals ze
    -- opgeslagen stond. Daarna de kleur van het ziekenhuis opnieuw, nu op het
    -- volledige lijstje — de browser kende er maar een deel van.
    || case when (stored ? 'pipeline') or (incoming ? 'pipeline')
            then jsonb_build_object('pipeline',
                   followup.merge_pipeline(stored -> 'pipeline', incoming -> 'pipeline', allowed))
            else '{}'::jsonb end)), false);
$$;

create or replace function followup.merge_targets(stored jsonb, incoming jsonb,
                                                  allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  with s as (select key, value from jsonb_each(followup.obj(stored))),
       p as (select key, value from jsonb_each(followup.obj(incoming))),
       y as (select key from s union select key from p)
  select coalesce((
    select jsonb_object_agg(y.key,
      -- de doelen van de andere producten blijven onaangeroerd ...
      coalesce((select jsonb_object_agg(k.key, k.value)
                  from jsonb_each(followup.obj((select value from s where s.key = y.key))) k
                 where k.key <> all(allowed)), '{}'::jsonb)
      -- ... en over zijn eigen producten beslist de gebruiker. Een jaartal dat
      -- hij niet meestuurde blijft gewoon staan.
      || coalesce((select jsonb_object_agg(k.key, k.value)
                     from jsonb_each(followup.obj((select value from p where p.key = y.key))) k
                    where k.key = any(allowed)), '{}'::jsonb))
      from y), '{}'::jsonb);
$$;

create or replace function followup.merge_doc(stored jsonb, incoming jsonb,
                                              allowed text[], mag_verwijderen boolean) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_pay        jsonb;
  v_stored_ids text[];
  v_ziekenhuizen jsonb := '[]'::jsonb;
  v_uit        jsonb;
  v_h          jsonb;
begin
  -- Dubbele id's zijn er in check_payload al uitgevallen, dus jsonb_object_agg
  -- kan hier niets stil overschrijven.
  select coalesce(jsonb_object_agg(t.e ->> 'id', t.e), '{}'::jsonb) into v_pay
    from jsonb_array_elements(followup.arr(incoming -> 'hospitals')) t(e);
  select coalesce(array_agg(t.e ->> 'id'), '{}'::text[]) into v_stored_ids
    from jsonb_array_elements(followup.arr(stored -> 'hospitals')) t(e);

  -- De bestaande ziekenhuizen, in hun bestaande volgorde: dat houdt de
  -- dagelijkse kopieën met elkaar vergelijkbaar.
  for v_h in select t.e from jsonb_array_elements(followup.arr(stored -> 'hospitals')) t(e)
  loop
    if v_pay ? (v_h ->> 'id') then
      v_ziekenhuizen := v_ziekenhuizen || jsonb_build_array(
        followup.merge_hospital(v_h, v_pay -> (v_h ->> 'id'), allowed));
    elsif not mag_verwijderen then
      raise exception 'followup:no_delete je mag ziekenhuis % niet verwijderen', v_h ->> 'name'
        using errcode = 'PT403', hint = 'no_delete', detail = v_h ->> 'id';
    elsif not (followup.texts(v_h -> 'products') <@ allowed)
          or followup.vreemde_data(v_h, allowed) then
      -- Hier werkt het andere product ook aan: dan is dit niet jouw beslissing.
      -- Het vinkje én de inhoud tellen: een ziekenhuis zonder vinkje kan nog
      -- altijd contactmomenten van de collega bevatten.
      raise exception 'followup:out_of_scope ziekenhuis % hoort ook bij een ander product', v_h ->> 'name'
        using errcode = 'PT403', hint = 'out_of_scope', detail = v_h ->> 'id';
    end if;
    -- en anders: weg, en dus niet toegevoegd.
  end loop;

  -- Wat nieuw is in de payload.
  for v_h in select t.e from jsonb_array_elements(followup.arr(incoming -> 'hospitals')) t(e)
              where t.e ->> 'id' <> all(v_stored_ids)
  loop
    if not (followup.texts(v_h -> 'products') <@ allowed) then
      raise exception 'followup:out_of_scope nieuw ziekenhuis % met een product dat je niet mag', v_h ->> 'name'
        using errcode = 'PT403', hint = 'out_of_scope';
    end if;
    -- Ook een splinternieuw ziekenhuis gaat door merge_entries, met een lege
    -- opgeslagen lijst. Dat kost hier niets en het past dezelfde twee regels
    -- toe als overal elders: niets van een vreemd product erin, en een
    -- productlijst op een contactpersoon gesnoeid op het eigen bereik.
    v_ziekenhuizen := v_ziekenhuizen || jsonb_build_array(
      followup.fix_rooms_demo('{}'::jsonb, followup.fix_planned(
        v_h || jsonb_build_object(
          'contacts',   followup.merge_entries('[]'::jsonb, v_h -> 'contacts',   allowed, 'contactpersoon'),
          'activities', followup.merge_entries('[]'::jsonb, v_h -> 'activities', allowed, 'contactmoment'),
          'planned',    followup.merge_entries('[]'::jsonb, v_h -> 'planned',    allowed, 'gepland moment'))
        || case when v_h ? 'pipeline'
                then jsonb_build_object('pipeline', followup.scope_pipeline(v_h -> 'pipeline', allowed))
                else '{}'::jsonb end)));
  end loop;

  -- We vertrekken van het document in de databank en vervangen enkel wat we
  -- begrijpen. Zo blijft een sleutel die wij niet kennen staan, en kan een
  -- beperkte opslag er ook niets aan veranderen.
  v_uit := stored || jsonb_build_object('hospitals', v_ziekenhuizen);

  -- Het versienummer mag vooruit (een migratie in de app), nooit achteruit:
  -- dat laatste zou elke app de migraties opnieuw laten uitvoeren.
  v_uit := v_uit || jsonb_build_object('version', case
    when jsonb_typeof(incoming -> 'version') <> 'number' then coalesce(stored -> 'version', to_jsonb(1))
    when jsonb_typeof(stored -> 'version') <> 'number'   then incoming -> 'version'
    when (incoming ->> 'version')::numeric >= (stored ->> 'version')::numeric then incoming -> 'version'
    else stored -> 'version' end);

  if (stored ? 'targets') or (incoming ? 'targets') then
    v_uit := v_uit || jsonb_build_object('targets',
      followup.merge_targets(stored -> 'targets', incoming -> 'targets', allowed));
  end if;

  return v_uit;
end $$;


-- Van één fase per ziekenhuis naar een fase per product. Een ziekenhuis van
-- vóór de opvolging per product heeft producten aangevinkt en nog geen enkele
-- rij in pipeline; dan krijgt élk aangevinkt product de fase en de kleur die
-- het ziekenhuis had. Dezelfde regel als syncPipeline() in de app, maar hier,
-- en dat is het punt: de app van een afgeschermde gebruiker kent alleen zijn
-- eigen product. Liet je de omzetting aan haar over, dan maakte ze één rij
-- aan, en vond de collega daarna een ziekenhuis "met opvolging" waarin zijn
-- product ontbrak — klant werd weer eerste contact.
--
-- Daarom gebeurt het hier voor alle producten tegelijk, op drie plaatsen:
-- onderaan dit bestand één keer op het opgeslagen document, en in read_state
-- en write_state voor het geval er toch nog een oud document binnenkomt (een
-- back-up van vroeger, een browser met de vorige versie van de app). Op een
-- omgezet document doet dit niets, dus laden en opslaan blijft hetzelfde
-- document teruggeven.
create or replace function followup.opvolging_aanvullen(doc jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(doc -> 'hospitals') is distinct from 'array' then doc
    else doc || jsonb_build_object('hospitals', coalesce((
      select jsonb_agg(case
               when followup.obj(t.e -> 'pipeline') = '{}'::jsonb
                    and cardinality(followup.texts(t.e -> 'products')) > 0
               then t.e || jsonb_build_object('pipeline', (
                      select jsonb_object_agg(p.x, jsonb_build_object(
                               'stage',  coalesce(t.e ->> 'stage',  'prospect'),
                               'status', coalesce(t.e ->> 'status', 'red'),
                               'owner',  ''))
                        from unnest(followup.texts(t.e -> 'products')) p(x)))
               else t.e end order by t.i)
        from jsonb_array_elements(doc -> 'hospitals') with ordinality t(e, i)
    ), '[]'::jsonb))
  end;
$$;


-- ---------------------------------------------------------------------------
-- 10. Lezen en schrijven: het enige dat de app nog ziet
-- ---------------------------------------------------------------------------

-- data is null als er nog geen document is; de app biedt dan de startlijst aan.
-- role en products komen mee omdat de app ze nodig heeft (knoppen verbergen,
-- keuzelijstjes beperken) én omdat ze zeggen met welke afscherming dit
-- document is uitgelezen. Dat hoort bij elkaar.
create or replace function public.read_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'data',       followup.scope_doc(followup.opvolging_aanvullen(s.data), p.products),
           'updated_at', to_jsonb(s.updated_at),
           'role',       to_jsonb(followup.my_role()),
           'products',   to_jsonb(p.products))
    from (select followup.my_products() as products) p
    left join public.app_state s on s.id = 'main';
$$;

-- Een eerdere versie van dit script had write_state met twee argumenten. Laten
-- we die staan, dan bestaan er twee functies met dezelfde naam en weet
-- PostgREST niet meer welke bedoeld wordt.
drop function if exists public.write_state(jsonb, timestamptz);

-- mode 'save' is de gewone opslag; 'import' is een back-up over de data zetten
-- en mag enkel een onbeperkte editor of admin. Zonder dat onderscheid is "een
-- aanvuller mag niet importeren" niet te handhaven: een import van de back-up
-- van gisteren kan elk id bevatten dat er nu ook is, verwijdert dus niets, en
-- draait tegelijk elk veld van elk record terug.
create or replace function public.write_state(payload jsonb,
                                              expected_at timestamptz,
                                              mode text default 'save') returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  -- Zoveel mag er in één opslag verdwijnen. De app verwijdert één ding per
  -- keer, achter een confirm(), en bewaart 400 ms later — een echte opslag komt
  -- hier dus nooit aan. Waar dit wél tegen beschermt: een gebruiker wiens
  -- bereik net is veranderd (hij stuurt zijn oude, kleine stuk op en dat zou nu
  -- als het hele document gelden), een half geladen document, en een fout in de
  -- app. Een echte grote opkuis doe je met mode => 'import'.
  c_max_ziekenhuizen constant int := 1;
  c_max_records      constant int := 5;
  v_rol        text := followup.my_role();
  v_bereik     text[] := followup.my_products();
  v_wie        text := coalesce(auth.uid()::text, '');
  -- Onze eigen dag, niet die van de server: Supabase staat op UTC, en dan
  -- kreeg een contactmoment dat hier om half twee 's nachts wordt ingevoerd
  -- de datum van gisteren te zien.
  v_dag        text := to_char((now() at time zone 'Europe/Brussels')::date, 'YYYY-MM-DD');
  v_stored     jsonb;
  v_huidig     timestamptz;
  v_nieuw      jsonb;
  v_sleutels   text[];
  v_weg        text[];
  v_weg_h      text[];
  v_weg_r      text[];
  v_at         timestamptz;
begin
  if mode not in ('save', 'import') then
    raise exception 'followup:invalid_payload onbekende mode %', mode
      using errcode = 'PT422', hint = 'invalid_payload';
  end if;
  if v_rol = 'viewer' then
    raise exception 'followup:readonly je mag enkel lezen'
      using errcode = 'PT403', hint = 'readonly';
  end if;
  if mode = 'import' then
    if v_rol not in ('admin', 'editor') then
      raise exception 'followup:no_import importeren mag enkel een bewerker of beheerder'
        using errcode = 'PT403', hint = 'no_import';
    end if;
    if followup.via_assistant() then
      -- Een back-up terugzetten vervangt alles. Dat doet een mens in de app,
      -- niet een sleutel die bij een assistent ligt.
      raise exception 'followup:no_import importeren kan niet via een assistent'
        using errcode = 'PT403', hint = 'no_import';
    end if;
    if v_bereik <> '{}'::text[] then
      -- Wie maar een deel van het document ziet, kan er geen volledig document
      -- over zetten: alles wat hij niet zag, zou verdwijnen.
      raise exception 'followup:no_import importeren kan niet met een productbeperking'
        using errcode = 'PT403', hint = 'no_import';
    end if;
  end if;

  perform followup.check_payload(payload);

  -- Eerst de rij vastzetten, dan pas vergelijken: tussen het vergelijken en het
  -- schrijven mag er niets gebeuren, anders is de hele controle theater.
  select s.data, s.updated_at into v_stored, v_huidig
    from public.app_state s where s.id = 'main' for update;

  if not found then
    -- Nog geen document: een leeg project vullen. Dat hoort bij een onbeperkte
    -- bewerker of beheerder.
    if expected_at is not null then
      raise exception 'followup:conflict er is geen document (meer)'
        using errcode = 'PT409', hint = 'conflict';
    end if;
    if v_rol not in ('admin', 'editor') or v_bereik <> '{}'::text[] then
      raise exception 'followup:out_of_scope een leeg project vullen mag enkel een onbeperkte bewerker'
        using errcode = 'PT403', hint = 'out_of_scope';
    end if;
    v_nieuw := case when mode = 'import' then payload
                    else followup.stamp_doc('{}'::jsonb, payload, v_wie, v_dag) end;
    begin
      insert into public.app_state (id, data, updated_at, updated_by)
      values ('main', v_nieuw, now(), auth.uid())
      returning updated_at into v_at;
    exception when unique_violation then
      raise exception 'followup:conflict iemand anders heeft ondertussen opgeslagen'
        using errcode = 'PT409', hint = 'conflict';
    end;
    return v_at;
  end if;

  -- is distinct from, niet <>: een payload met expected_at null terwijl er wél
  -- een document staat, is ook een conflict.
  if v_huidig is distinct from expected_at then
    raise exception 'followup:conflict iemand anders heeft ondertussen opgeslagen'
      using errcode = 'PT409', hint = 'conflict',
            detail = 'Herlaad en doe je wijziging opnieuw.';
  end if;

  if v_bereik = '{}'::text[] then
    -- Geen beperking: deze gebruiker zag alles, dus zijn document is het
    -- document. De controles hieronder blijven wél gelden.
    v_nieuw := payload;
  else
    -- Samenvoegen met het omgezette document: zo staat de rij van de collega
    -- er al vóór deze gebruiker de zijne erbij zet.
    v_nieuw := followup.merge_doc(followup.opvolging_aanvullen(v_stored), payload, v_bereik, v_rol in ('admin', 'editor'));
  end if;
  -- En wat een onbeperkte gebruiker stuurt vanuit een app die de opvolging per
  -- product nog niet kent. Op een omgezet document verandert dit niets.
  v_nieuw := followup.opvolging_aanvullen(v_nieuw);

  -- De stempel zet de databank, niet de browser. Bij een import niet: die zet
  -- een back-up terug zoals hij was, inclusief wie wat ooit invoerde.
  if mode <> 'import' then
    v_nieuw := followup.stamp_doc(v_stored, v_nieuw, v_wie, v_dag);
  end if;

  -- Wat is er verdwenen? We vergelijken met wat er écht geschreven wordt, niet
  -- met de payload: na het samenvoegen kan dat verschillen.
  v_sleutels := followup.doc_keys(v_nieuw);
  v_weg := array(select k from unnest(followup.doc_keys(v_stored)) k
                  where k <> all(v_sleutels));

  -- Een afgevinkt gepland moment verdwijnt uit planned[] en komt als
  -- contactmoment terug met hetzelfde id (app.js hergebruikt plan.id). Dat is
  -- geen verwijdering, en het is de enige uitzondering die we nodig hebben:
  -- geen vlaggetje in de payload dat we op zijn woord moeten geloven, maar een
  -- id dat we zelf zien terugkomen.
  v_weg := array(select k from unnest(v_weg) k
                  where not (k like 'p:%' and ('a:' || substr(k, 3)) = any(v_sleutels)));

  if v_rol = 'contributor' and coalesce(array_length(v_weg, 1), 0) > 0 then
    raise exception 'followup:no_delete je mag niets verwijderen'
      using errcode = 'PT403', hint = 'no_delete',
            detail = 'Verdwenen: ' || array_to_string(v_weg, ', ');
  end if;

  if mode <> 'import' then
    if jsonb_array_length(followup.arr(payload -> 'hospitals')) = 0
       and jsonb_array_length(followup.arr(v_stored -> 'hospitals')) > 0 then
      raise exception 'followup:empty_payload een opslag zonder ziekenhuizen over een gevuld document'
        using errcode = 'PT422', hint = 'empty_payload',
              detail = 'Herlaad de app. Een back-up terugzetten gaat met mode => import.';
    end if;
    v_weg_h := array(select k from unnest(v_weg) k where k like 'h:%');
    -- De records van een verwijderd ziekenhuis gaan mee en tellen niet apart.
    v_weg_r := array(select k from unnest(v_weg) k
                      where k not like 'h:%'
                        and ('h:' || split_part(k, ':', 2)) <> all(v_weg_h));
    if coalesce(array_length(v_weg_h, 1), 0) > c_max_ziekenhuizen
       or coalesce(array_length(v_weg_r, 1), 0) > c_max_records then
      raise exception 'followup:too_many_deletes % ziekenhuizen en % records verdwijnen in één opslag',
            coalesce(array_length(v_weg_h, 1), 0), coalesce(array_length(v_weg_r, 1), 0)
        using errcode = 'PT422', hint = 'too_many_deletes',
              detail = 'Zoveel verwijdert de app nooit in één keer. Herlaad de app.';
    end if;
  end if;

  update public.app_state
     set data = v_nieuw, updated_at = now(), updated_by = auth.uid()
   where id = 'main'
  returning updated_at into v_at;
  return v_at;
end $$;


-- Is er iets veranderd sinds ik laadde? De app vraagt dit wanneer je naar het
-- tabblad terugkeert, en haalt het document pas op als het antwoord anders is
-- dan wat ze heeft. Het is alleen het tijdstip van de laatste opslag: daar
-- staat niets in van welk product ook, dus hier hoeft geen muur omheen.
-- Geen rij (nog geen document) geeft null terug.
create or replace function public.state_version() returns timestamptz
language sql stable security definer set search_path = public as $$
  select updated_at from public.app_state where id = 'main';
$$;


-- ---------------------------------------------------------------------------
-- 11. Rechten
-- ---------------------------------------------------------------------------

-- app_state is vanaf hier onbereikbaar via de Data API: alles loopt door de
-- twee functies hierboven, en die schermen af op product. De policies gaan weg
-- maar de rij-beveiliging blijft aan — zonder policy mag niets, ook niet als
-- iemand later per ongeluk rechten teruggeeft of "Automatically expose new
-- tables" aanzet.
revoke select, insert, update, delete on public.app_state from authenticated;
-- En de dagelijkse kopieën al zeker niet: dát is het volledige document zonder
-- enige afscherming. Zolang die grant er stond, was de muur een deur.
-- Terugzetten blijft werk voor het dashboard, zoals voorheen.
revoke select, insert, update, delete on public.app_state_backups from authenticated;

drop policy if exists "aangemeld lezen" on public.app_state;
drop policy if exists "aangemeld toevoegen" on public.app_state;
drop policy if exists "aangemeld wijzigen" on public.app_state;
drop policy if exists "schrijfrecht toevoegen" on public.app_state;
drop policy if exists "schrijfrecht wijzigen" on public.app_state;
drop policy if exists "aangemeld back-ups lezen" on public.app_state_backups;

alter table public.app_state enable row level security;
alter table public.app_state_backups enable row level security;
alter table public.app_users enable row level security;

-- Iedereen die aangemeld is mag de gebruikerslijst lezen: de app zet "door
-- <naam>" bij een contactmoment, en daarvoor moet ze de namen kennen. Er staat
-- niets gevoeligers in dan een naam, een rol en een bereik. Enkel een
-- beheerder mag er iets aan veranderen, en verwijderen kan niet — geen delete
-- in de rechten en geen policy ervoor, net als bij app_state.
grant usage on schema public to authenticated;
grant select, insert, update on public.app_users to authenticated;

drop policy if exists "aangemeld gebruikers lezen" on public.app_users;
drop policy if exists "beheerder gebruikers toevoegen" on public.app_users;
drop policy if exists "beheerder gebruikers wijzigen" on public.app_users;

create policy "aangemeld gebruikers lezen" on public.app_users
  for select to authenticated using (true);
create policy "beheerder gebruikers toevoegen" on public.app_users
  for insert to authenticated with check (public.is_admin());
create policy "beheerder gebruikers wijzigen" on public.app_users
  for update to authenticated using (public.is_admin())
  with check (public.is_admin());

-- Een functie is standaard voor iedereen uitvoerbaar, en van alles in "public"
-- maakt PostgREST een /rpc/-adres. Daarom hier expliciet welke vier dat zijn.
revoke all on function public.state_version() from public, anon;
grant execute on function public.state_version() to authenticated;
revoke all on function public.read_state() from public, anon;
revoke all on function public.write_state(jsonb, timestamptz, text) from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.read_state() to authenticated;
grant execute on function public.write_state(jsonb, timestamptz, text) to authenticated;
grant execute on function public.is_admin() to authenticated;

-- may_write() bestond voor de policies op app_state, en die zijn hierboven weg:
-- alles loopt nu door write_state(). Een functie in public wordt een /rpc/-adres,
-- dus laten we er geen staan die niemand nog gebruikt.
drop function if exists public.may_write();

-- Het schema followup krijgt géén usage: de rekenhulpjes zijn van de twee
-- functies hierboven (die lopen als eigenaar) en van de SQL-editor.
revoke all on schema followup from anon, authenticated;

revoke all on public.app_state, public.app_state_backups, public.app_users from anon;


-- ---------------------------------------------------------------------------
-- Eenmalig: het opgeslagen document omzetten naar een fase per product
-- ---------------------------------------------------------------------------
-- Zie followup.opvolging_aanvullen() hierboven. Staat alles al om, dan raakt
-- dit geen rij aan — het mag dus bij elke uitvoering van dit bestand opnieuw
-- lopen. De trigger bewaart zoals altijd de toestand van vóór de wijziging in
-- app_state_backups. updated_at blijft staan: wie de app open heeft, krijgt
-- geen conflictmelding voor een wijziging die hij niet kan zien.
update public.app_state
   set data = followup.opvolging_aanvullen(data)
 where id = 'main'
   and data is distinct from followup.opvolging_aanvullen(data);
