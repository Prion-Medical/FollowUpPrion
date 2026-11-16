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
-- kennen komt achteraan in plaats van weg te vallen, onderling op de bytes
-- van de naam (collate "C": hoofdletters vóór kleine letters, zoals sort()
-- in JavaScript), zodat de volgorde niet afhangt van de taal van de server.
-- Dubbels vallen weg.
create or replace function followup.product_sort(v text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce((
    select array_agg(q.x order by coalesce(array_position(followup.producten(), q.x), 99), q.x collate "C")
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
-- Eén vorm. Een contactpersoon, een contactmoment en een gepland moment
-- dragen hun producten allemaal in de lijst "products", ook als het er één of
-- geen is: dezelfde arts is vaak het aanspreekpunt voor twee producten, en een
-- gesprek kan over twee producten tegelijk gaan. Eén overlapping volstaat:
-- wie Ainex mag, ziet de arts die EndoQ én Ainex doet, en het gesprek dat
-- over allebei ging.
--
-- Tot issue 22 droeg een moment meestal één "product", en enkel een lijst
-- zodra er een tweede product bij kwam. lijstvorm() hieronder zet dat om, op
-- elke weg naar binnen en naar buiten; wat hierna komt, kent enkel de lijst.
-- De tegenhanger van productsOf() in domain.js.
create or replace function followup.products_of(e jsonb) returns text[]
language sql immutable set search_path = public as $$
  -- Enkel de lijst: lijstvorm() zette het oude "product" al om. obj(): wat
  -- geen object is, heeft geen producten.
  select followup.texts(followup.obj(e) -> 'products');
$$;

create or replace function followup.in_scope(e jsonb, allowed text[]) returns boolean
language sql immutable set search_path = public as $$
  select followup.products_of(e) = '{}'::text[]
      or followup.both_in(followup.products_of(e), allowed) <> '{}'::text[];
$$;

-- (opgeslagen \ bereik) ∪ (payload ∩ bereik). Zo kan een beperkte opslag nooit
-- het product van de collega wegnemen, en beslist de gebruiker wel volledig
-- over het zijne. Geldt voor het ziekenhuis én voor een contactpersoon: allebei
-- dragen een lijst producten die twee mensen samen invullen.
create or replace function followup.merge_products(stored jsonb, incoming jsonb,
                                                   allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select to_jsonb(followup.product_sort(
           followup.only_in(followup.products_of(stored),   allowed)
        || followup.both_in(followup.products_of(incoming), allowed)));
$$;

-- ---------------------------------------------------------------------------
-- Eén vorm: de producten van een record staan altijd in een lijst (issue 22)
-- ---------------------------------------------------------------------------
-- LET OP: dit is niet terug te draaien door een oudere schema.sql uit te
-- voeren. Twee redenen:
--   - scope_entries() kreeg een derde argument. Een oudere versie maakt de
--     variant met twee ernaast, en dan is elke oproep dubbelzinnig ("is not
--     unique"): read_state() faalt voor elke beperkte gebruiker.
--   - De oude zonder_aantal() haalt het aantal af van elk record dat een
--     lijst "products" draagt, en na de omzetting onderaan is dat elk
--     moment. Elke bestelling, installatie en procedure verloor bij de
--     volgende beperkte opslag haar aantal.
-- Terug kan enkel door eerst de nieuwe functies met de hand te verwijderen
-- (scope_entries met drie argumenten, lijstvorm, lijstvorm_hospital,
-- lijstvorm_record, een_lijst, aantal_eraf, zonder_aantal_beperkt met vier
-- argumenten, tellende_soorten, plan_bezet) en het
-- document terug te zetten uit app_state_backups van vóór de omzetting.
-- Een moment droeg vroeger één "product", en pas een lijst "products" zodra
-- iemand een tweede product aanvinkte. Elke lezer moest dus op de vorm
-- vertakken, hier en in de app en in de koppeling. Nu zet de databank elk
-- record om naar de lijst, op drie plaatsen: één keer op het opgeslagen
-- document onderaan dit bestand, bij het lezen (read_state) en bij het
-- schrijven (write_state, op wat er stond én op wat er binnenkomt). Net als
-- opvolging_aanvullen(): een oude back-up of een browser met de vorige app
-- komt zo toch in de nieuwe vorm binnen.
--
-- Dat de databank het doet en niet de app, is wat het veilig maakt: een
-- omzetting door de app ging door write_state() en zijn stempel, en dan was
-- de eerste die opsloeg de laatste wijziger van het hele logboek. Hier
-- verandert geen stempel.

-- Een moment over meer dan één product draagt geen aantal en geen soort
-- stent: die horen bij één product. Een beperkte gebruiker ziet van een
-- gesprek over Thyroid RFA en Fibroid RFA enkel het zijne, als een lijst van
-- één, en kon er zo een bestelling met een aantal van maken; na het
-- samenvoegen stond dat aantal op een moment over twee producten. De app en
-- de koppeling bieden het niet aan (de vlag "shared", zie scope_entries); dit
-- is het vangnet. Het telt de volledige lijst, zoals ze opgeslagen of
-- samengevoegd is — niet de lengte die de browser zag. Enkel wat er staat
-- wordt weggehaald, zodat een moment zonder aantal ongewijzigd blijft.
--
-- Een lijst die terug naar één product gaat, is weer een gewoon moment over
-- één product en mag dan wél een aantal dragen.
create or replace function followup.aantal_eraf(e jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select (e - 'family')
      || case when coalesce(jsonb_typeof(e -> 'rooms'), 'null') <> 'null'
              then '{"rooms": null}'::jsonb else '{}'::jsonb end;
$$;

create or replace function followup.zonder_aantal(e jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when (select count(distinct x) from unnest(followup.products_of(e)) x) <= 1 then e
    else followup.aantal_eraf(e)
  end;
$$;

-- Hetzelfde na het samenvoegen van een beperkte opslag, met één regel erbij:
-- wie beperkt is, zet nooit een aantal op een moment waar het product van een
-- collega op staat. Ook niet als dat er na het samenvoegen het enige is. Een
-- Ainex-gebruiker die zijn eigen product van een gesprek over EndoQ en Ainex
-- haalt en er een installatie van drie kamers van maakt, hield anders een
-- moment over enkel EndoQ over mét drie kamers — en die telden mee in de
-- geïnstalleerde kamers van het ziekenhuis. Enkel bij momenten: een
-- contactpersoon draagt geen aantal.
--
-- En om dezelfde reden geen soort die telt: een installatie, een
-- stopzetting, een bestelling of een procedure. Een bestelling zonder aantal
-- telt in de app als één verkocht stuk, een installatie zonder aantal zet het
-- product van de collega op klant zodra hij zich er later van afhaalt. Wie
-- beperkt is, maakt van een moment met het product van een collega dus geen
-- tellende soort die er niet al stond: vorige is de soort die er stond (het
-- opgeslagen moment, of het plan dat afgevinkt wordt), en die blijft dan.
-- Stil, zoals het aantal: de app en de koppeling bieden het niet aan. Een
-- andere soort die niet telt, mag wel.
create or replace function followup.tellende_soorten() returns text[]
language sql immutable set search_path = public as $$
  select array['installation', 'cancellation', 'order', 'procedure'];
$$;

-- De vorige versie had drie argumenten; blijft die staan, dan zijn er twee.
drop function if exists followup.zonder_aantal_beperkt(jsonb, text[], boolean);

create or replace function followup.zonder_aantal_beperkt(e jsonb, vorige jsonb, allowed text[],
                                                          moment boolean) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when moment and followup.only_in(followup.products_of(e), allowed) <> '{}'::text[]
      then followup.aantal_eraf(case
             when (e ->> 'type') = any(followup.tellende_soorten())
                  and (e -> 'type') is distinct from vorige
               then (e - 'type') || jsonb_strip_nulls(jsonb_build_object('type', vorige))
             else e end)
    else followup.zonder_aantal(e)
  end;
$$;

-- De omzetting van één record. Staat er een lijst, dan blijft die en
-- verdwijnt een los "product" ernaast. Anders wordt het ene "product" een
-- lijst van één, of een lege lijst als er geen was. Dezelfde regel als
-- normalize() in de app (toProductList), voor een back-up die rechtstreeks
-- geïmporteerd wordt. Wat geen object is, blijft wat het was: dat keurt
-- check_payload() of niet.
--
-- De lijst komt er altijd op één manier uit: enkel tekst die niet leeg is,
-- zonder dubbels, in de volgorde van product_sort(). Zo telt "meer dan één
-- product" overal hetzelfde (twee keer Ainex is één product), en verandert
-- een lijst niet meer van volgorde zodra een beperkte gebruiker ze opslaat —
-- wat anders een nieuwe laatste wijziger gaf voor een moment dat niemand
-- aanraakte.
create or replace function followup.een_lijst(e jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(e) is distinct from 'object' then e
    else (e - 'product') || jsonb_build_object('products', to_jsonb(followup.product_sort(array(
           select x from unnest(case when jsonb_typeof(e -> 'products') = 'array'
                                     then followup.texts(e -> 'products')
                                     else followup.texts(jsonb_build_array(e -> 'product')) end) x
            where x <> ''))))
  end;
$$;

-- Een moment krijgt er twee dingen bij. "shared" gaat eraf: die vlag zet
-- read_state() op wat het voor een beperkte gebruiker gesnoeid heeft (zie
-- scope_entries), en ze is een mededeling aan de browser, geen gegeven. Bleef
-- ze staan, dan veranderde een gedeeld moment bij elke opslag en kreeg het
-- telkens een nieuwe laatste wijziger. En een moment over meer producten
-- verliest zijn aantal (zonder_aantal). Een contactpersoon krijgt enkel de
-- lijst: hij draagt geen aantal en geen vlag.
create or replace function followup.lijstvorm_record(e jsonb, moment boolean) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(e) is distinct from 'object' then e
    when not moment then followup.een_lijst(e)
    else followup.zonder_aantal(followup.een_lijst(e) - 'shared')
  end;
$$;

create or replace function followup.lijstvorm_hospital(h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(h) is distinct from 'object' then h
    -- Enkel de lijsten die er staan: seed.json heeft geen planned, en daar
    -- mag er geen lege bij komen.
    else h || coalesce((
      select jsonb_object_agg(k.lijst, (
               select coalesce(jsonb_agg(followup.lijstvorm_record(c.e, k.moment) order by c.i), '[]'::jsonb)
                 from jsonb_array_elements(h -> k.lijst) with ordinality c(e, i)))
        from (values ('contacts', false), ('activities', true), ('planned', true)) as k(lijst, moment)
       where jsonb_typeof(h -> k.lijst) = 'array'), '{}'::jsonb)
  end;
$$;

-- Het hele document. Staat alles al in de lijstvorm, dan komt het document
-- ongewijzigd terug zonder dat er iets herbouwd wordt; dat is na de omzetting
-- onderaan dit bestand bij bijna elke oproep zo. Een tweede keer verandert
-- dus niets, en laden en opslaan blijft hetzelfde document teruggeven.
create or replace function followup.lijstvorm(doc jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(doc -> 'hospitals') is distinct from 'array' then doc
    when not exists (
      select 1
        from jsonb_array_elements(doc -> 'hospitals') t(e)
        cross join (values ('contacts', false), ('activities', true), ('planned', true)) as k(lijst, moment)
        cross join lateral jsonb_array_elements(followup.arr(t.e -> k.lijst)) c(e)
       where followup.lijstvorm_record(c.e, k.moment) is distinct from c.e) then doc
    else doc || jsonb_build_object('hospitals', (
      select jsonb_agg(followup.lijstvorm_hospital(t.e) order by t.i)
        from jsonb_array_elements(doc -> 'hospitals') with ordinality t(e, i)))
  end;
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

-- De fases vóór de verkoop: wie daar staat en een bestelling of installatie
-- krijgt, wordt klant. De kopie van PRE_SALE in public/domain.js;
-- tests/lijsten.mjs legt ze naast elkaar.
create or replace function followup.voor_verkoop() returns text[]
language sql immutable set search_path = public as $$
  select array['prospect', 'first_contact', 'meeting', 'demo_planned', 'demo_installed', 'evaluation', 'purchasing'];
$$;

-- De soorten contactmoment die bestaan: de sleutels van ACT_TYPES in
-- public/domain.js, in dezelfde volgorde; tests/lijsten.mjs legt ze naast
-- elkaar. Een soort die hier niet in staat, maakt de app bij het laden
-- "other" — daarom telt zo'n verandering niet als een andere soort.
create or replace function followup.soorten() returns text[]
language sql immutable set search_path = public as $$
  select array['prospecting', 'email', 'call', 'visit', 'congress', 'demo', 'procedure',
               'installation', 'training', 'quote', 'order', 'cancellation', 'other'];
$$;

-- De producten die per ingreep verkocht worden in plaats van per abonnement:
-- de kopie van productKind() in public/domain.js. Wat hier niet in staat is
-- een abonnement, net als daar, zodat een product dat de databank nog niet
-- kent zich gedraagt zoals alles zich tot nu toe gedroeg. Het verschil telt
-- twee keer: na een demo of procedure staat zo'n product "in evaluatie" in
-- plaats van "demo geïnstalleerd", en zijn aantal zijn stuks en geen kamers.
create or replace function followup.per_ingreep() returns text[]
language sql immutable set search_path = public as $$
  select array['Thyroid RFA', 'Fibroid RFA', 'Stents'];
$$;

-- Kent dit product deze fase? De regel achter stagesFor() in public/domain.js
-- (niet de hele functie: een fase die in geen enkele lijst staat, keurt dit
-- niet af, waar stagesFor() ze niet kent):
-- één lijst van fases voor alle producten, maar een product per ingreep wordt
-- niet geïnstalleerd (geen "demo_installed") en een abonnement wordt niet
-- aangekocht langs het Comité Medisch Materiaal (geen "purchasing").
create or replace function followup.kent_fase(p text, stage text) returns boolean
language sql immutable set search_path = public as $$
  select stage is distinct from
         case when p = any(followup.per_ingreep()) then 'demo_installed' else 'purchasing' end;
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
-- als syncNextAction() in de app: sorteren op datum, met de momenten zonder
-- datum vooraan, dan het eerste.
--
-- Een moment zonder datum is iets dat moet gebeuren maar nog geen dag heeft.
-- Het blijft bovenaan staan tot iemand het afvinkt; nextActionDate is dan
-- leeg en nextAction is zijn nota. Tot november 2026 vielen zulke momenten
-- hier weg, en de app gooide ze bij het laden ook weg. Een oudere app tegen
-- deze databank gooit ze dus nog steeds weg: zet de app en dit schema samen
-- online.
--
-- Draait ook bij het afschermen, en daar is het meer dan opruimen:
-- nextAction is de nota van het eerste geplande moment, en dat kan er een
-- van het andere product zijn. Zonder deze herberekening stuurden we die
-- tekst mee naar een browser die het moment zelf niet mag zien.
create or replace function followup.fix_planned(h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  with p as (
    select coalesce((
      -- Op datum, op dezelfde dag op uur (wat geen uur heeft na wat er een
      -- heeft), wat geen datum heeft vooraan: zoals byWhen() in de app.
      select jsonb_agg(t.e order by coalesce(t.e ->> 'date', ''), coalesce(t.e ->> 'time', '99'), t.i)
        from jsonb_array_elements(followup.arr(h -> 'planned')) with ordinality t(e, i)
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

-- Contactpersonen, contactmomenten en geplande momenten: één functie. De
-- productlijst van een record (een arts voor twee producten, een gesprek over
-- twee producten tegelijk) gaat gesnoeid mee: het record blijft zichtbaar
-- zodra er één product overlapt, maar het product van de collega staat er
-- niet bij. Een Ainex-gebruiker die het EndoQ-vinkje van een arts ziet, leest
-- daaruit af dat de collega met die arts bezig is, en kon het uitzetten. De
-- velden zelf zijn gedeeld. Het document is hier al in de lijstvorm.
--
-- gedeeld: bij een moment (niet bij een contactpersoon) zetten we "shared":
-- true op wat we gesnoeid hebben. Wie enkel Thyroid RFA mag, krijgt een
-- gesprek over Thyroid én Fibroid als ["Thyroid RFA"], en uit die lengte kan
-- zijn browser niet meer afleiden dat het moment gedeeld is en dus geen
-- aantal mag dragen. De vlag zegt het hem. Wat niet gesnoeid werd, krijgt
-- niets, zodat een onbeperkte lezer exact het opgeslagen document ziet;
-- write_state() haalt de vlag er weer af (lijstvorm_record).
-- Tot issue 22 had deze functie twee argumenten; die versie moet weg, anders
-- is een oproep met twee argumenten dubbelzinnig.
drop function if exists followup.scope_entries(jsonb, text[]);

create or replace function followup.scope_entries(entries jsonb, allowed text[],
                                                  gedeeld boolean default false) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(case when jsonb_typeof(t.e) is distinct from 'object' then t.e
                          else t.e || jsonb_build_object('products', to_jsonb(g.lijst))
                               || case when gedeeld
                                            and cardinality(g.lijst) < cardinality(followup.product_sort(followup.products_of(t.e)))
                                       then '{"shared": true}'::jsonb else '{}'::jsonb end
                     end order by t.i)
      from jsonb_array_elements(followup.arr(entries)) with ordinality t(e, i)
      cross join lateral (select followup.product_sort(
                                   followup.both_in(followup.products_of(t.e), allowed)) as lijst) g
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
    'contacts',   followup.scope_entries(h -> 'contacts', allowed),
    'activities', followup.scope_entries(h -> 'activities', allowed, true),
    'planned',    followup.scope_entries(h -> 'planned', allowed, true))
    -- De opvolging van de andere producten gaat niet mee, en de kleur van het
    -- ziekenhuis wordt herrekend op wat overblijft.
    || case when h ? 'pipeline'
            then jsonb_build_object('pipeline', followup.scope_pipeline(h -> 'pipeline', allowed))
            else '{}'::jsonb end),
    followup.heeft_opvolging(h));
$$;

-- scope_contacts was een letterlijke kopie van scope_entries; die doet nu alle
-- drie de lijsten.
drop function if exists followup.scope_contacts(jsonb, text[]);

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
-- Een record zonder id telt bewust niet mee. Dat is niet te volgen, en
-- normalize() in de app geeft het bij het laden een nieuw id — dan leek elke
-- eerste opslag na zo'n document op een verwijdering.
--
-- Een gepland moment zonder datum telt wél mee, sinds dat een gewoon moment
-- is dat bovenaan blijft staan. Telde het niet, dan kon een contributor het
-- ongezien weghalen.
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
       -- ook een gepland moment zonder datum: zie hierboven
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

  -- Een id met een stuurteken (een regeleinde, een tab) maakt de app nooit:
  -- uid() geeft hextekens. Wie er toch een stuurt, schrijft niet langs de
  -- app, en een id komt op plaatsen terecht die het niet ontsnappen, zoals de
  -- UID in een agenda-abonnement.
  select k into v_bad from unnest(followup.doc_keys(payload)) k
   where k ~ '[[:cntrl:]]' limit 1;
  if v_bad is not null then
    raise exception 'followup:invalid_payload een id bevat een stuurteken'
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
-- op bij het gedeelde getal en raakt dat van EndoQ niet. Sinds issue 21 telt
-- de databank dat verschil zelf, bij het opgeslagen getal: zie
-- opvolging_bijwerken() in deel 9b.

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

-- zonder_aantal() staat bij lijstvorm() bovenaan: het draait ook bij het
-- omzetten van een volledig document, en dan na het samenvoegen hieronder
-- nog eens op de volledige lijst.

-- Tot november 2026 had deze functie vier argumenten. Bleef die versie staan,
-- dan waren er twee met dezelfde naam en was elke oproep met vier argumenten
-- dubbelzinnig.
drop function if exists followup.merge_entries(jsonb, jsonb, text[], text);

-- afgevinkt: geplande momenten die in deze opslag afgevinkt worden (zie
-- followup.afgevinkt()). Een nieuw contactmoment met hetzelfde id neemt
-- daaruit het product van de collega over; zijn plaats in de lijst blijft die
-- uit de payload, zoals bij elk nieuw record.
create or replace function followup.merge_entries(stored jsonb, incoming jsonb,
                                                  allowed text[], wat text,
                                                  afgevinkt jsonb default '[]'::jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_bad    text;
  -- Een contactmoment of een gepland moment, geen contactpersoon.
  v_moment boolean := wat is distinct from 'contactpersoon';
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

  -- Een gedeeld gepland moment afvinken zonder een eigen product: wat er dan
  -- overblijft, is een contactmoment dat enkel over het product van een
  -- collega gaat, ingevoerd door iemand die dat product niet mag — met de
  -- soort van het plan, en een geplande bestelling telt dan als verkocht.
  -- Wie niet meer bij een gedeeld plan hoort, haalt zich van het plan af;
  -- afvinken doet wie erbij blijft.
  if afgevinkt <> '[]'::jsonb then
    select p.e ->> 'id' into v_bad
      from jsonb_array_elements(followup.arr(incoming)) p(e)
      join jsonb_array_elements(followup.arr(afgevinkt)) x(e) on x.e ->> 'id' = p.e ->> 'id'
     where followup.only_in(followup.products_of(x.e), allowed) <> '{}'::text[]
       and followup.both_in(followup.products_of(p.e), allowed) = '{}'::text[]
     limit 1;
    if v_bad is not null then
      raise exception 'followup:out_of_scope % % — een gedeeld gepland moment afvinken zonder een eigen product kan niet; haal je product van het geplande moment af', wat, v_bad
        using errcode = 'PT403', hint = 'out_of_scope';
    end if;
  end if;

  -- Buiten het zicht: letterlijk uit de databank, op zijn oude plaats.
  -- Binnen het zicht en meegestuurd: de versie van de gebruiker, op dezelfde
  -- plaats. Nieuw: achteraan, zoals de app zelf ook toevoegt. Binnen het zicht
  -- en niet meegestuurd: verwijderd — write_state beslist of dat mocht.
  --
  -- De productlijst gaat door dezelfde formule als bij het ziekenhuis in
  -- plaats van rechtstreeks uit de payload te komen: de browser zag enkel
  -- zijn eigen deel ervan. Bij een contactpersoon en bij een moment, want
  -- allebei dragen ze een lijst (lijstvorm). Daarna zonder_aantal_beperkt()
  -- op de volledige lijst: wat de browser als een moment over één product
  -- zag, kan er na het samenvoegen weer twee hebben, of enkel dat van de
  -- collega.
  return coalesce((
    with s as (select t.e, t.i from jsonb_array_elements(followup.arr(stored))   with ordinality t(e, i)),
         p as (select t.e, t.i from jsonb_array_elements(followup.arr(incoming)) with ordinality t(e, i))
    select jsonb_agg(q.e order by q.groep, q.i) from (
      select s.e, 0 as groep, s.i from s where not followup.in_scope(s.e, allowed)
      union all
      -- Wie zichzelf van een gedeeld moment afhaalt (het stond er met het
      -- product van een collega, en van de zijne blijft er niets over),
      -- haalt enkel zijn vinkje weg: de rest van het moment blijft zoals het
      -- opgeslagen stond. Anders kon hij met dezelfde opslag de soort of de
      -- nota veranderen van wat nu enkel over het product van de collega
      -- gaat — een gesprek omzetten in een bestelling, bijvoorbeeld.
      select followup.zonder_aantal_beperkt(
               case when v_moment
                         and followup.only_in(followup.products_of(s.e), allowed) <> '{}'::text[]
                         and followup.both_in(followup.products_of(p.e), allowed) = '{}'::text[]
                    then s.e else p.e end
               || jsonb_build_object('products', followup.merge_products(s.e, p.e, allowed)),
               s.e -> 'type', allowed, v_moment), 0, s.i
        from s join p on p.e ->> 'id' = s.e ->> 'id'
       where followup.in_scope(s.e, allowed)
      union all
      -- Wat geen object is, gaat zoals het kwam: daar valt geen lijst aan te
      -- hangen.
      select case when jsonb_typeof(p.e) is distinct from 'object' then p.e
                  else followup.zonder_aantal_beperkt(p.e
                         || jsonb_build_object('products', followup.merge_products(coalesce(x.e, '{}'::jsonb), p.e, allowed)),
                         x.e -> 'type', allowed, v_moment) end,
             1, p.i
        from p
        left join lateral (select t.e from jsonb_array_elements(followup.arr(afgevinkt)) t(e)
                            where t.e ->> 'id' = p.e ->> 'id' limit 1) x on true
       where not exists (select 1 from s where s.e ->> 'id' = p.e ->> 'id')
    ) q
  ), '[]'::jsonb);
end $$;

-- De geplande momenten die in deze opslag afgevinkt worden: binnen het zicht,
-- hun id duikt op als nieuw contactmoment, en het plan zelf is weg. Dat
-- laatste telt: een zelfgemaakt contactmoment met het id van een gedeeld plan
-- dat blijft staan, is geen afvinken, en kreeg anders het product van de
-- collega mee. write_state() weigert zo'n opslag bovendien (plan_bezet).
create or replace function followup.afgevinkt(stored jsonb, incoming jsonb, allowed text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(t.e), '[]'::jsonb)
    from jsonb_array_elements(followup.arr(stored -> 'planned')) t(e)
   where followup.in_scope(t.e, allowed)
     and exists (select 1 from jsonb_array_elements(followup.arr(incoming -> 'activities')) a(e)
                  where a.e ->> 'id' = t.e ->> 'id')
     and not exists (select 1 from jsonb_array_elements(followup.arr(incoming -> 'planned')) p(e)
                      where p.e ->> 'id' = t.e ->> 'id')
     and not exists (select 1 from jsonb_array_elements(followup.arr(stored -> 'activities')) a(e)
                      where a.e ->> 'id' = t.e ->> 'id');
$$;

-- Een nieuw contactmoment met het id van een opgeslagen plan dat blijft
-- staan. Afvinken hergebruikt het id van het plan en haalt het plan weg;
-- blijft het plan staan, dan is het id bezet, en loopt het echte afvinken
-- later vast op een dubbel id. Voor een beperkte gebruiker staat het plan
-- van de collega altijd nog in het samengevoegde document, dus ook dat geval
-- valt hieronder. Geeft de eerste sleutel terug, of null.
create or replace function followup.plan_bezet(stored jsonb, doc jsonb) returns text
language sql immutable set search_path = public as $$
  select t.e ->> 'id' || ':' || (a.e ->> 'id')
    from jsonb_array_elements(followup.arr(doc -> 'hospitals')) t(e)
    left join lateral (select x.e from jsonb_array_elements(followup.arr(stored -> 'hospitals')) x(e)
                        where x.e ->> 'id' = t.e ->> 'id' limit 1) o on true
    cross join lateral jsonb_array_elements(followup.arr(t.e -> 'activities')) a(e)
   where coalesce(a.e ->> 'id', '') <> ''
     and not exists (select 1 from jsonb_array_elements(followup.arr(o.e -> 'activities')) b(e)
                      where b.e ->> 'id' = a.e ->> 'id')
     and exists (select 1 from jsonb_array_elements(followup.arr(o.e -> 'planned')) b(e)
                  where b.e ->> 'id' = a.e ->> 'id')
     and exists (select 1 from jsonb_array_elements(followup.arr(t.e -> 'planned')) b(e)
                  where b.e ->> 'id' = a.e ->> 'id')
   limit 1;
$$;

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
      -- Afvinken: het contactmoment krijgt het id van het geplande moment. Was
      -- dat een gesprek over twee producten, dan zag een beperkte gebruiker
      -- enkel het zijne; het geplande moment is dan wat er opgeslagen stond,
      -- zodat het product van de collega op het contactmoment blijft staan.
      'activities', followup.merge_entries(stored -> 'activities', incoming -> 'activities', allowed,
                      'contactmoment', followup.afgevinkt(stored, incoming, allowed)),
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
                               -- Een fase die dit product niet kent, schuift naar
                               -- de dichtste die het wel kent, zoals in
                               -- syncPipeline() in de app.
                               'stage',  case
                                 when followup.kent_fase(p.x, coalesce(t.e ->> 'stage', 'prospect'))
                                   then coalesce(t.e ->> 'stage', 'prospect')
                                 else 'evaluation' end,
                               'status', coalesce(t.e ->> 'status', 'red'),
                               'owner',  ''))
                        from unnest(followup.texts(t.e -> 'products')) p(x)))
               else t.e end order by t.i)
        from jsonb_array_elements(doc -> 'hospitals') with ordinality t(e, i)
    ), '[]'::jsonb))
  end;
$$;


-- ---------------------------------------------------------------------------
-- 9b. Wat een contactmoment met de opvolging doet
-- ---------------------------------------------------------------------------
-- Een bestelling maakt een product groen en klant, een eerste gesprek zet
-- rood op oranje, een demo zet de fase op "demo geïnstalleerd", een
-- installatie telt kamers bij. Dat stond in de app (autoStatus, syncPipeline,
-- syncRooms in public/domain.js) en als volledige kopie in de koppeling voor
-- een assistent. Liepen die twee uit elkaar, dan zette hetzelfde bezoek een
-- ziekenhuis anders naargelang wie het invoerde, en dat verschil werd
-- opgeslagen (issue 21).
--
-- Nu beslist de databank, bij elke gewone opslag. De app houdt haar kopie,
-- zodat de kleur meteen verandert en server.py blijft werken, en neemt daarna
-- over wat hier opgeslagen werd — zoals bij de stempel. De koppeling schrijft
-- enkel het moment en laat de rest aan dit stuk over.
--
-- Twee dingen moeten blijven kunnen, en daarom kijkt dit enkel naar wat
-- nieuw is:
--   - de fase met de hand zetten. De regels lopen alleen voor een
--     contactmoment dat er nog niet stond, of waarvan de soort veranderde —
--     nooit bij elke opslag, anders draaiden ze een fase terug die iemand zelf
--     koos.
--   - het aantal kamers met de hand zetten. We tellen enkel het verschil dat
--     de contactmomenten maken; is er geen verschil, dan blijft het getal uit
--     de payload staan.
-- De prijs, bewust: wie in dezelfde opslag een nieuw moment invoert én de
-- fase met de hand verzet, ziet die fase door het moment overschreven; en een
-- met de hand getypt aantal kamers in dezelfde opslag als een installatie
-- gaat verloren. De app bewaart die twee nooit samen.
--
-- Niet hier: stageStatus() (een fase met de hand → een kleur) en
-- zonderProduct() (het laatste product afgevinkt). Die gaan niet over een
-- contactmoment, en blijven in de app en de koppeling.

-- Hoeveel kamers dit contactmoment installeert: + bij een installatie, − bij
-- een stopzetting, anders niets. Enkel bij een product per abonnement: een
-- bestelling van stents telt stuks, geen kamers. Een moment zonder product
-- telt wél mee, zoals in syncRooms(): productKind("") is een abonnement, en
-- de installaties van vóór er producten waren hebben geen product.
--
-- Een getal lezen zoals Number() in de app het doet: een getal, of tekst die
-- er een is ("2"). Oudere data heeft er zo een paar, en de app maakt er bij
-- het laden een getal van; lazen we hier enkel echte getallen, dan leek de
-- eerste opslag daarna op een installatie van twee kamers.
create or replace function followup.getal(v jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*-?\d+(\.\d+)?\s*$' then (v #>> '{}')::numeric
    else null end;
$$;

create or replace function followup.geinstalleerd(a jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case
    -- Eerst de soort: bijna elk moment is geen installatie of stopzetting, en
    -- dit loopt over elk moment van een ziekenhuis bij elke opslag.
    when (a ->> 'type') is distinct from 'installation' and (a ->> 'type') is distinct from 'cancellation' then 0
    -- Een moment over meer dan één product draagt geen aantal: zonder_aantal()
    -- haalt het eraf. Telden we een oud aantal hier toch, dan leek de eerste
    -- opslag daarna een stopzetting. Het aantal producten telt, niet de vorm:
    -- sinds issue 22 is elk moment een lijst, en een lijst van één is een
    -- gewoon moment over één product.
    when (select count(distinct x) from unnest(followup.products_of(a)) x) > 1 then 0
    -- Eén product per ingreep: stuks, geen kamers. Geen product telt wél.
    when (followup.products_of(a))[1] = any(followup.per_ingreep()) then 0
    when a ->> 'type' = 'installation' then coalesce(followup.getal(a -> 'rooms'), 0)
    when a ->> 'type' = 'cancellation' then -coalesce(followup.getal(a -> 'rooms'), 0)
    else 0 end;
$$;

-- Eén contactmoment op één opvolging: de rij van een product, of het
-- ziekenhuis zelf zolang daar geen product aan hangt. Dezelfde regel als in
-- autoStatus(), in dezelfde volgorde: eerst de kleur (en de fase die daarbij
-- hoort), dan wat een demo of procedure aan de fase doet. Een tweede keer
-- verandert niets — groen blijft groen, oranje wordt niet nog eens oranje —
-- en daarom maakt het niet uit dat de browser het al gedaan had.
create or replace function followup.na_moment(x jsonb, soort text, ingreep boolean) returns jsonb
language sql immutable set search_path = public as $$
  with k as (
    select case
      when soort in ('installation', 'order') and (x ->> 'status') is distinct from 'green'
        then x || '{"status": "green"}'::jsonb
               || case when x ->> 'stage' = any(followup.voor_verkoop())
                       then '{"stage": "customer"}'::jsonb else '{}'::jsonb end
      when x ->> 'status' = 'red'
        then x || '{"status": "orange"}'::jsonb
               || case when x ->> 'stage' = 'prospect'
                       then '{"stage": "first_contact"}'::jsonb else '{}'::jsonb end
      else x end as y
  )
  -- Na een demo: geïnstalleerd bij een product per abonnement, in evaluatie
  -- bij een product per ingreep. Een procedure waar een van ons bij stond is
  -- daar hetzelfde. Een klant blijft klant.
  select case
    when soort in ('demo', 'procedure')
         and k.y ->> 'stage' in ('prospect', 'first_contact', 'meeting', 'demo_planned')
      then k.y || jsonb_build_object('stage', case when ingreep then 'evaluation' else 'demo_installed' end)
    else k.y end
  from k;
$$;

-- Wat de app bij het laden van een contactmoment maakt (normalizeActivity in
-- app.js), voor zover het hier telt: een soort die niet bestaat wordt
-- "other", een datum die geen JJJJ-MM-DD is wordt leeg. Wie de opgeslagen
-- versie zo leest, ziet een oud record niet als gewijzigd alleen omdat de app
-- het rechtzette.
create or replace function followup.soort_van(a jsonb) returns text
language sql immutable set search_path = public as $$
  select case when a ->> 'type' = any(followup.soorten()) then a ->> 'type' else 'other' end;
$$;

create or replace function followup.datum_van(a jsonb) returns text
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(a -> 'date') = 'string' and a ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
              then a ->> 'date' else '' end;
$$;

-- De sleutel van een opgeslagen moment zonder id: soort, producten en datum,
-- zoals de app ze na het laden heeft. Staat er in de payload een moment met
-- een id en dezelfde sleutel, dan is het dat moment — de app gaf het bij het
-- laden een id — en niet een nieuw. Niet "gelijk op het id na": de app vult
-- bij het laden ook andere velden aan (contactId, note). Beide kanten zijn
-- al in de lijstvorm, dus een oud "product": "EndoQ" en een nieuw
-- "products": ["EndoQ"] geven dezelfde sleutel.
create or replace function followup.zonder_id_sleutel(a jsonb) returns text
language sql immutable set search_path = public as $$
  select followup.soort_van(a) || '|' || array_to_string(followup.products_of(a), ',')
         || '|' || followup.datum_van(a);
$$;

-- Stap 1 en 2: de rijen en wat de nieuwe contactmomenten ermee doen. stored
-- is het opgeslagen ziekenhuis (al omgezet, '{}' voor een nieuw), h het
-- ziekenhuis dat geschreven gaat worden, allowed het bereik ('{}' is
-- onbeperkt). Geeft h terug met de bijgewerkte pipeline en, als een moment op
-- het ziekenhuis zelf sloeg, zijn status en stage. De kleur van het geheel
-- (fix_overall) rekent de aanroeper.
--
-- Dit draait terwijl de rij in app_state vastgezet is, dus het moet lineair
-- blijven in de grootte van de opslag: de opvolging en de kleur van het
-- ziekenhuis gaan als kleine variabelen door de lus en komen pas op het eind
-- één keer terug in h, en de opgeslagen momenten worden één keer opgezocht.
-- Met een jsonb_set op h per moment duurde een opslag van 8.000 nieuwe
-- momenten een halve minuut.
create or replace function followup.fix_pipeline(stored jsonb, h jsonb, allowed text[]) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_beperkt boolean := not (allowed is null or allowed = '{}'::text[]);
  -- Wat deze gebruiker kan kiezen, zoals myProducts() in de app: zijn bereik,
  -- of elk product als hij onbeperkt is.
  v_bereik  text[] := case when v_beperkt then allowed else followup.producten() end;
  v_pijp    jsonb := followup.obj(h -> 'pipeline');   -- bijgewerkt in de lus
  v_vinkjes text[] := followup.texts(h -> 'products');
  v_zh_in   jsonb;            -- status en stage van het ziekenhuis zelf
  v_zh      jsonb;
  v_genoemd text[];
  v_oud     jsonb;            -- opgeslagen momenten met een id, op id
  v_zonder  jsonb;            -- opgeslagen momenten zonder id, op zonder_id_sleutel()
  v_p       text;
  v_a       jsonb;
  v_naam    text[];
  v_doel    text[];
  v_rijen   text[];
begin
  v_zh_in := coalesce((select jsonb_object_agg(k, h -> k) from unnest(array['status', 'stage']) k
                        where h ? k), '{}'::jsonb);
  v_zh := v_zh_in;
  v_oud := coalesce((select jsonb_object_agg(t.e ->> 'id', t.e)
                       from jsonb_array_elements(followup.arr(stored -> 'activities')) t(e)
                      where coalesce(t.e ->> 'id', '') <> ''), '{}'::jsonb);
  v_zonder := coalesce((select jsonb_object_agg(followup.zonder_id_sleutel(t.e), true)
                          from jsonb_array_elements(followup.arr(stored -> 'activities')) t(e)
                         where coalesce(t.e ->> 'id', '') = ''), '{}'::jsonb);

  -- 1. Elk aangevinkt product heeft een rij, zoals syncPipeline() die maakt
  --    voor een product dat er later bijkomt: eerste contact als er al een
  --    contactmoment over gaat, anders prospect. Een ziekenhuis zonder enige
  --    rij is hier al omgezet (opvolging_aanvullen), dus dit is altijd "later".
  --    Wie beperkt is, maakt enkel rijen binnen zijn bereik: de rij van een
  --    collega is niet de zijne om aan te maken.
  v_genoemd := coalesce((select array_agg(distinct x)
                           from jsonb_array_elements(followup.arr(h -> 'activities')) t(e),
                                unnest(followup.products_of(t.e)) x), '{}'::text[]);
  for v_p in select distinct x from unnest(v_vinkjes) x
              where x = any(followup.producten())
                and (not v_beperkt or x = any(allowed))
                and jsonb_typeof(v_pijp -> x) is distinct from 'object'
  loop
    v_pijp := v_pijp || jsonb_build_object(v_p,
                case when v_p = any(v_genoemd)
                     then '{"stage": "first_contact", "status": "orange", "owner": ""}'::jsonb
                     else '{"stage": "prospect", "status": "red", "owner": ""}'::jsonb end);
  end loop;

  -- 2. De contactmomenten die iets doen: nieuw, of met een andere soort dan
  --    er opgeslagen stond. Een afgevinkt gepland moment is hier nieuw: zijn
  --    id stond in planned, niet in activities. Een moment zonder id volgen we
  --    niet — de app geeft het bij het laden een id, en anders deed het bij
  --    elke opslag opnieuw iets.
  --
  --    De opgeslagen versie lezen we zoals de app ze na het laden heeft
  --    (soort_van, zonder_id_sleutel): een soort die niet bestaat is "other",
  --    dus "other" opslaan verandert niets, maar er een bestelling van maken
  --    wel; en een opgeslagen moment zonder id dat de app een id gaf, is niet
  --    nieuw.
  for v_a in select t.e
               from jsonb_array_elements(followup.arr(h -> 'activities')) with ordinality t(e, i)
              where coalesce(t.e ->> 'id', '') <> ''
                and case
                      when v_oud ? (t.e ->> 'id') then
                        followup.soort_van(v_oud -> (t.e ->> 'id')) <> followup.soort_van(t.e)
                      -- Zonder opgeslagen momenten zonder id hoeft er geen
                      -- sleutel berekend te worden: dat is bijna altijd zo.
                      when v_zonder = '{}'::jsonb then true
                      else not v_zonder ? followup.zonder_id_sleutel(t.e)
                    end
              order by t.i
  loop
    v_naam := followup.products_of(v_a);
    if v_beperkt and cardinality(v_naam) > 0 and not (v_naam && allowed) then
      -- Een moment over enkel producten buiten het bereik: niet van deze
      -- gebruiker, dus niets beweegt. merge_entries() laat zo'n moment al
      -- niet binnen; dit houdt de functie ook op zichzelf veilig.
      continue;
    end if;
    -- Wat het moment noemt, binnen het bereik, en een rij heeft, beweegt
    -- mee. Het bereik telt ook hier: wie enkel Thyroid RFA mag en een gepland
    -- gesprek over Thyroid én Fibroid afvinkt, verzet de rij van zijn collega
    -- niet. Dat is de muur, en zo toont zijn browser het ook.
    v_doel := coalesce((select array_agg(q.x order by q.i)
                          from unnest(v_naam) with ordinality q(x, i)
                         where (not v_beperkt or q.x = any(allowed))
                           and jsonb_typeof(v_pijp -> q.x) = 'object'), '{}'::text[]);
    if cardinality(v_doel) = 0 then
      -- Geen product genoemd: hangt er binnen het bereik precies één aan het
      -- ziekenhuis, dan is het dat. Meer, dan valt niet te raden welk en
      -- blijft alles staan. Geen, dan is het het ziekenhuis zelf. Het bereik
      -- telt: wie enkel Ainex mag en een moment zonder product invoert, heeft
      -- het over Ainex, ook al hangt EndoQ er ook aan.
      v_rijen := coalesce((select array_agg(distinct x) from unnest(v_bereik) x
                            where x = any(v_vinkjes)
                              and jsonb_typeof(v_pijp -> x) = 'object'), '{}'::text[]);
      if cardinality(v_rijen) = 1 then
        v_doel := v_rijen;
      elsif cardinality(v_rijen) = 0 then
        v_zh := followup.na_moment(v_zh, v_a ->> 'type', false);
      end if;
    end if;
    foreach v_p in array v_doel loop
      v_pijp := v_pijp || jsonb_build_object(v_p,
                  followup.na_moment(v_pijp -> v_p, v_a ->> 'type', v_p = any(followup.per_ingreep())));
    end loop;
  end loop;

  -- Eén keer terug in h, en enkel wat veranderde: een ziekenhuis zonder
  -- pipeline krijgt er geen lege bij.
  if v_pijp is distinct from followup.obj(h -> 'pipeline') then
    h := h || jsonb_build_object('pipeline', v_pijp);
  end if;
  if v_zh is distinct from v_zh_in then
    h := h || v_zh;
  end if;
  return h;
end $$;

-- Stap 3: de geïnstalleerde kamers, de tegenhanger van fix_rooms_demo().
-- Wat er opgeslagen stond plus het verschil dat de contactmomenten maken.
-- Niet wat de browser stuurde plus dat verschil: die telde het al op, en dan
-- stond het er twee keer bij. Zonder verschil blijft het getal uit de payload:
-- dat is een getal dat iemand met de hand zette. Een stopzetting op een leeg
-- veld laat het leeg, zoals syncRooms(): niemand wist hoeveel er stonden.
--
-- Bewust anders dan de app bij meer dan één kamermoment in één opslag:
-- syncRooms() rekent per moment (en laat een stopzetting op een leeg veld
-- vallen vóór een installatie erbij komt), hier telt het netto verschil. De
-- app en de koppeling bewaren één moment per opslag, dus het verschil toont
-- zich enkel bij een import-achtige opslag of een zelfgebouwde payload.
create or replace function followup.fix_rooms_installed(stored jsonb, h jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when q.delta > 0 or (q.delta < 0 and coalesce(jsonb_typeof(q.kamers), 'null') <> 'null')
      then h || jsonb_build_object('unit', followup.obj(h -> 'unit') || jsonb_build_object('roomsInstalled',
             greatest(0, coalesce(followup.getal(q.kamers), 0) + q.delta)))
    else h end
  from (select coalesce((select sum(followup.geinstalleerd(t.e))
                           from jsonb_array_elements(followup.arr(h -> 'activities')) t(e)), 0)
             - coalesce((select sum(followup.geinstalleerd(t.e))
                           from jsonb_array_elements(followup.arr(stored -> 'activities')) t(e)), 0) as delta,
               stored -> 'unit' -> 'roomsInstalled' as kamers) q;
$$;

-- Eén ziekenhuis: de rijen en de nieuwe momenten (fix_pipeline), de kamers
-- (fix_rooms_installed), en dan de kleur van het geheel. stored is het
-- ziekenhuis zoals het opgeslagen stond, al omgezet naar de opvolging per
-- product ('{}' voor een nieuw), h zoals het na het samenvoegen geschreven
-- zal worden. allowed is het bereik van wie opslaat; leeg is onbeperkt.
--
-- De kleur en de fase van het ziekenhuis worden herrekend zodra er iets aan
-- de opvolging veranderde: een regel hieronder, of een wijziging die mee
-- binnenkwam — een fase met de hand verzet, het verste product afgevinkt, een
-- product aangevinkt waarvan de rij al bestond. Een onbeperkte opslag komt
-- nooit langs merge_hospital(), dat het anders deed, en de koppeling rekent
-- het niet meer zelf uit. Is er niets veranderd, dan komt h ongewijzigd
-- terug: zo geeft laden en ongewijzigd opslaan hetzelfde document terug, ook
-- als er in de opgeslagen kleur iets niet klopt.
create or replace function followup.opvolging_bijwerken(stored jsonb, h jsonb,
                                                        allowed text[]) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_in jsonb := h;
begin
  if jsonb_typeof(h) is distinct from 'object' then
    return h;
  end if;
  stored := followup.obj(stored);
  -- Niets veranderd aan dit ziekenhuis: niets te beslissen. Dat is bijna
  -- elk ziekenhuis bij elke opslag, dus ook de snelste weg.
  if h = stored then
    return h;
  end if;

  h := followup.fix_rooms_installed(stored, followup.fix_pipeline(stored, h, allowed));

  -- De kleur en de fase van het ziekenhuis: die van het product dat het
  -- verst staat. Zonder aangevinkt product blijft de eigen kleur staan.
  if h is distinct from v_in
     or (v_in -> 'products') is distinct from (stored -> 'products')
     or (v_in -> 'pipeline') is distinct from (stored -> 'pipeline') then
    h := followup.fix_overall(h, false);
  end if;
  return h;
end $$;

-- Het hele document, voor write_state(). Enkel bij een gewone opslag: een
-- import zet een back-up terug zoals hij was, en daar beslist niemand iets
-- opnieuw. Elke opslag gaat erdoor, ook een onbeperkte die nooit langs
-- merge_hospital() komt — daarom over het hele document, zoals stamp_doc().
--
-- Allebei al omgezet naar de opvolging per product (opvolging_aanvullen) en
-- naar de lijstvorm (lijstvorm): stored
-- is het opgeslagen document, doc wat er geschreven gaat worden. write_state()
-- zet ze allebei om, zodat ze tegen dezelfde basis vergeleken worden als het
-- samenvoegen van een beperkte opslag.
create or replace function followup.opvolging_bijwerken_doc(stored jsonb, doc jsonb,
                                                            allowed text[], mode text) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when mode is distinct from 'save' or jsonb_typeof(doc -> 'hospitals') is distinct from 'array' then doc
    else doc || jsonb_build_object('hospitals', coalesce((
            -- De opgeslagen ziekenhuizen één keer op id gezet, in plaats van
            -- per ziekenhuis de hele lijst door te lopen.
            select jsonb_agg(followup.opvolging_bijwerken(coalesce(op.m -> (t.e ->> 'id'), '{}'::jsonb),
                                                          t.e, allowed) order by t.i)
              from jsonb_array_elements(doc -> 'hospitals') with ordinality t(e, i),
                   (select coalesce(jsonb_object_agg(x.e ->> 'id', x.e), '{}'::jsonb) as m
                      from jsonb_array_elements(followup.arr(stored -> 'hospitals')) x(e)
                     where coalesce(x.e ->> 'id', '') <> '') op
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
--
-- Eerst de twee omzettingen (de lijstvorm en de opvolging per product), dan
-- de muur. Een onbeperkte lezer krijgt zo exact het omgezette opgeslagen
-- document; een beperkte krijgt "shared" op elk moment dat gesnoeid werd.
create or replace function public.read_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'data',       followup.scope_doc(followup.opvolging_aanvullen(followup.lijstvorm(s.data)), p.products),
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
  v_basis      jsonb;
  v_huidig     timestamptz;
  v_nieuw      jsonb;
  v_sleutels   text[];
  v_weg        text[];
  v_weg_h      text[];
  v_weg_r      text[];
  v_at         timestamptz;
  v_bad        text;
begin
  -- Ook null: "not in" geeft dan null, en elke latere vraag naar de modus
  -- ook. Dan viel het maximum aan verwijderingen weg, en de stempel en de
  -- regels evengoed. Een oproep zonder modus is fout, geen gewone opslag.
  if mode is null or mode not in ('save', 'import') then
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
  -- Wat binnenkomt in de lijstvorm, in elke modus: een oude back-up, een
  -- browser met de vorige app. Ook "shared" gaat er hier af, vóór de stempel
  -- en het samenvoegen; anders gold elk gedeeld moment als gewijzigd. Na de
  -- keuring, want die kijkt naar de vorm; de omzetting verandert geen id en
  -- geen lijst in iets anders dan een lijst.
  payload := followup.lijstvorm(payload);

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

  -- Het opgeslagen document, omgezet naar de lijstvorm en de opvolging per
  -- product: de basis voor het samenvoegen, voor de regels en voor de
  -- stempel hieronder, zodat die drie hetzelfde vergelijken. Vergeleek de
  -- stempel met het niet omgezette document, dan was elk moment dat nog een
  -- los "product" droeg gewijzigd, en de opslagger zijn laatste wijziger.
  v_basis := followup.opvolging_aanvullen(followup.lijstvorm(v_stored));

  if v_bereik = '{}'::text[] then
    -- Geen beperking: deze gebruiker zag alles, dus zijn document is het
    -- document. De controles hieronder blijven wél gelden.
    v_nieuw := payload;
  else
    -- Samenvoegen met het omgezette document: zo staat de rij van de collega
    -- er al vóór deze gebruiker de zijne erbij zet.
    v_nieuw := followup.merge_doc(v_basis, payload, v_bereik, v_rol in ('admin', 'editor'));
  end if;
  -- En wat een onbeperkte gebruiker stuurt vanuit een app die de opvolging per
  -- product nog niet kent. Op een omgezet document verandert dit niets.
  v_nieuw := followup.opvolging_aanvullen(v_nieuw);

  -- Een nieuw contactmoment op het id van een plan dat blijft staan: zie
  -- plan_bezet(). Niet bij een import, die zet terug wat er was.
  if mode = 'save' then
    v_bad := followup.plan_bezet(v_basis, v_nieuw);
    if v_bad is not null then
      raise exception 'followup:duplicate_id contactmoment % heeft het id van een gepland moment dat blijft staan', v_bad
        using errcode = 'PT422', hint = 'duplicate_id',
              detail = 'Afvinken haalt het geplande moment weg; een nieuw contactmoment krijgt een eigen id.';
    end if;
  end if;

  -- Wat een nieuw contactmoment met de opvolging doet, beslist de databank:
  -- de kleur en de fase per product, en de geïnstalleerde kamers. Op het
  -- samengevoegde document, zodat de rij van een collega meetelt maar enkel
  -- beweegt als het moment over zijn product gaat. Bij een import niet: zie
  -- opvolging_bijwerken_doc().
  v_nieuw := followup.opvolging_bijwerken_doc(v_basis, v_nieuw, v_bereik, mode);

  -- De stempel zet de databank, niet de browser. Bij een import niet: die zet
  -- een back-up terug zoals hij was, inclusief wie wat ooit invoerde.
  if mode <> 'import' then
    v_nieuw := followup.stamp_doc(v_basis, v_nieuw, v_wie, v_dag);
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
    -- Een ziekenhuis met contactmomenten of geplande momenten verwijdert enkel
    -- een beheerder: daarmee gaat de geschiedenis van iedereen mee, ook wat
    -- een collega er logde. Een leeg ziekenhuis (een dubbele invoer, een
    -- tikfout) mag een bewerker nog altijd weghalen. We kijken naar wat
    -- opgeslagen stond, niet naar wat deze gebruiker ervan zag.
    if v_rol <> 'admin' and exists (
         select 1 from jsonb_array_elements(followup.arr(v_basis -> 'hospitals')) t(e)
          where ('h:' || (t.e ->> 'id')) = any(v_weg_h)
            and (jsonb_array_length(followup.arr(t.e -> 'activities')) > 0
                 or jsonb_array_length(followup.arr(t.e -> 'planned')) > 0)) then
      raise exception 'followup:no_delete enkel een beheerder verwijdert een ziekenhuis met contactmomenten of geplande momenten'
        using errcode = 'PT403', hint = 'no_delete';
    end if;
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


-- ---------------------------------------------------------------------------
-- Eenmalig: elk moment en elke contactpersoon naar de lijstvorm (issue 22)
-- ---------------------------------------------------------------------------
-- Zie followup.lijstvorm() hierboven. Rechtstreeks in de tabel en niet via
-- write_state(): zo verandert er geen enkele stempel, en wordt niemand de
-- laatste wijziger van het hele logboek. Staat alles al om, dan raakt dit
-- geen rij aan, dus het mag bij elke uitvoering opnieuw lopen. De trigger
-- bewaart de toestand van vóór de omzetting in app_state_backups.
--
-- updated_at blijft staan, zoals hierboven. read_state() zet het document op
-- weg naar buiten al om, dus wie de nieuwe app open heeft, heeft deze vorm al
-- en hoeft niets op te halen; een oudere app stuurt de oude vorm, en die zet
-- write_state() om. Niemand krijgt een conflict voor iets wat hij niet kan zien.
update public.app_state
   set data = followup.lijstvorm(data)
 where id = 'main'
   and data is distinct from followup.lijstvorm(data);


-- ---------------------------------------------------------------------------
-- 12. Agenda-abonnementen
-- ---------------------------------------------------------------------------
-- Een agenda-app (Outlook, Google, Apple) haalt een adres op zonder dat er
-- iemand aangemeld is. Het adres zelf draagt dus het geheim, en wat het mag
-- tonen wordt hier beslist, met de muur van read_state(): een abonnement toont
-- nooit meer dan zijn eigenaar in de app ziet, en wie een product verliest,
-- verliest het bij de volgende ophaalbeurt ook in zijn agenda.
--
-- Het geheim staat hier enkel gehasht. De app krijgt het één keer te zien, bij
-- het aanmaken; wie het adres kwijt is, maakt een nieuw abonnement. Een
-- abonnement hoort bij een account (on delete cascade via app_users, dat zelf
-- aan auth.users hangt): verdwijnt het account, dan werken zijn adressen niet
-- meer.
create table if not exists public.calendar_feeds (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references public.app_users(id) on delete cascade,
  label        text not null default '',
  -- true: enkel wat voor de eigenaar gepland is. false: voor iedereen.
  mine         boolean not null default true,
  -- Leeg is alles wat de eigenaar mag, net als bij app_users.products.
  products     text[] not null default '{}',
  lang         text not null default 'nl' check (lang in ('nl', 'en')),
  secret_hash  text not null unique,
  created_at   timestamptz not null default now(),
  -- Wanneer een agenda het adres laatst ophaalde. Zo ziet een beheerder welke
  -- abonnementen nog leven en welke al lang niemand meer gebruikt.
  last_used    timestamptz
);
create index if not exists calendar_feeds_owner on public.calendar_feeds (owner);

-- Net als app_state: onbereikbaar via de Data API, alles loopt door de
-- functies hieronder. Rij-beveiliging aan en geen enkele policy, zodat ook een
-- grant die later per ongeluk terugkomt niets opent.
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;

-- Het geheim: 64 hextekens uit twee keer gen_random_uuid(), samen 244 bits
-- toeval. Beide zitten in Postgres zelf, er is geen extensie voor nodig.
create or replace function followup.feed_hash(secret text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(secret, 'UTF8')), 'hex');
$$;

-- Het maximum aantal abonnementen per account. Eén plek: feed_create()
-- handhaaft het, feed_list() geeft het mee zodat de app het formulier op tijd
-- weglaat. Vroeger stond het getal ook in app.js, met de vraag het op twee
-- plaatsen gelijk te houden.
create or replace function followup.feed_max() returns int
language sql immutable set search_path = public as $$ select 10 $$;

-- Een abonnement aanmaken. Geeft het id en het geheim terug; dat laatste
-- wordt nergens bewaard en is dus maar één keer te zien.
--
-- Niet met de sleutel van een assistent: een abonnement is een tweede sleutel
-- die niet verloopt, en die hoort een mens zelf aan te maken.
create or replace function public.feed_create(p_label text, p_mine boolean,
                                              p_products text[], p_lang text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  c_max      constant int := followup.feed_max();
  v_mine     text[] := followup.my_products();
  v_products text[];
  v_secret   text;
  v_id       uuid;
begin
  if auth.uid() is null
     or not exists (select 1 from public.app_users where id = auth.uid()) then
    raise exception 'followup:feed_denied niet aangemeld'
      using errcode = 'PT403', hint = 'feed_denied';
  end if;
  if followup.via_assistant() then
    raise exception 'followup:feed_denied een abonnement maak je in de app'
      using errcode = 'PT403', hint = 'feed_denied';
  end if;
  -- Eén aanmaak per account tegelijk, anders lopen twee gelijktijdige
  -- oproepen allebei langs de telling en komen er elf.
  perform pg_advisory_xact_lock(hashtext('calendar_feeds:' || auth.uid()::text));
  if (select count(*) from public.calendar_feeds where owner = auth.uid()) >= c_max then
    raise exception 'followup:feed_limit al % abonnementen', c_max
      using errcode = 'PT422', hint = 'feed_limit';
  end if;

  -- Enkel producten die bestaan, en voor een beperkt account enkel de zijne.
  -- Bleef er van een keuze niets over, dan zou leeg hier "alles" betekenen:
  -- dat is het omgekeerde van wat gevraagd werd, dus weigeren.
  v_products := followup.product_sort(followup.both_in(coalesce(p_products, '{}'), followup.producten()));
  if v_mine <> '{}'::text[] then
    v_products := followup.both_in(v_products, v_mine);
  end if;
  if coalesce(array_length(p_products, 1), 0) > 0 and v_products = '{}'::text[] then
    raise exception 'followup:out_of_scope geen van die producten mag je zien'
      using errcode = 'PT403', hint = 'out_of_scope';
  end if;

  v_secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.calendar_feeds (owner, label, mine, products, lang, secret_hash)
  values (auth.uid(), left(btrim(coalesce(p_label, '')), 80), coalesce(p_mine, true),
          v_products, case when p_lang = 'en' then 'en' else 'nl' end,
          followup.feed_hash(v_secret))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end $$;

-- De eigen abonnementen, of met everyone die van iedereen voor een beheerder,
-- samen met het maximum per account: {feeds: [...], max: 10}. Het geheim en
-- de hash gaan nooit mee. Tot november 2026 was het antwoord enkel de lijst;
-- storage.js leest allebei.
create or replace function public.feed_list(everyone boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  -- Abonnementen beheert een mens, in de app: ook bekijken en stopzetten, niet
  -- enkel aanmaken (zie feed_create).
  if followup.via_assistant() then
    raise exception 'followup:feed_denied abonnementen beheer je in de app'
      using errcode = 'PT403', hint = 'feed_denied';
  end if;
  if everyone and not public.is_admin() then
    raise exception 'followup:feed_denied enkel een beheerder ziet alle abonnementen'
      using errcode = 'PT403', hint = 'feed_denied';
  end if;
  return jsonb_build_object('max', followup.feed_max(), 'feeds', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', f.id, 'owner', f.owner, 'owner_name', coalesce(u.name, ''),
             'label', f.label, 'mine', f.mine, 'products', to_jsonb(f.products),
             'lang', f.lang, 'created_at', f.created_at, 'last_used', f.last_used)
           order by u.name, f.created_at)
      from public.calendar_feeds f
      join public.app_users u on u.id = f.owner
     where everyone or f.owner = auth.uid()
  ), '[]'::jsonb));
end $$;

-- Een abonnement stopzetten: door de eigenaar, of door een beheerder. Het
-- adres werkt vanaf dan niet meer. Geeft false als er niets te verwijderen
-- viel.
create or replace function public.feed_remove(p_id uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_n int;
begin
  if followup.via_assistant() then
    raise exception 'followup:feed_denied abonnementen beheer je in de app'
      using errcode = 'PT403', hint = 'feed_denied';
  end if;
  delete from public.calendar_feeds
   where id = p_id
     and (owner = auth.uid() or public.is_admin());
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- De geplande momenten van één abonnement, uit een document. Puur, zodat
-- controle.sql het met een verzonnen document kan nakijken zonder een
-- abonnement of een geheim aan te maken.
--
-- Eerst de muur van read_state(), met het bereik van de eigenaar; daarna pas
-- de keuzes van het abonnement, en die kunnen enkel verder versmallen.
-- Van "since" af (dertig dagen terug, zie hieronder). Geen contactpersoon:
-- dat zijn gegevens van een arts in de agenda van een derde partij, op
-- telefoons en vergrendelschermen.
create or replace function followup.feed_events(doc jsonb, scope text[], owner uuid,
                                                mine boolean, products text[],
                                                since text) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',       p.e ->> 'id',
             'date',     p.e ->> 'date',
             'time',     coalesce(p.e ->> 'time', ''),
             'type',     coalesce(p.e ->> 'type', ''),
             -- Al ingekort tot het bereik door scope_doc.
             'products', to_jsonb(followup.products_of(p.e)),
             'hospital', coalesce(h.e ->> 'name', ''),
             'address',  coalesce(h.e ->> 'address', ''),
             'country',  coalesce(h.e ->> 'country', ''),
             'note',     coalesce(p.e ->> 'note', ''),
             'updated',  coalesce(nullif(p.e ->> 'updatedAt', ''), p.e ->> 'createdAt', ''))
           order by p.e ->> 'date', coalesce(p.e ->> 'time', ''), h.e ->> 'name')
      from jsonb_array_elements(followup.arr(
             followup.scope_doc(followup.opvolging_aanvullen(followup.lijstvorm(doc)), coalesce(scope, '{}')) -> 'hospitals')) h(e)
      cross join lateral jsonb_array_elements(followup.arr(h.e -> 'planned')) p(e)
     where coalesce(p.e ->> 'date', '') >= since
       -- Voor wie: wie gekozen is, anders wie het invoerde (assigneeOf()).
       and (not mine
            or coalesce(nullif(p.e ->> 'assignee', ''), p.e ->> 'createdBy', '') = owner::text)
       -- Een keuze van producten: het moment moet er een van dragen. Een
       -- moment zonder product hoort bij geen enkele keuze, enkel bij "alles".
       and (coalesce(products, '{}') = '{}'::text[]
            or followup.both_in(followup.products_of(p.e), products) <> '{}'::text[])
  ), '[]'::jsonb);
$$;

-- Wat een agenda-app te zien krijgt. Zonder aanmelding uit te voeren: het
-- geheim ís de aanmelding. Onbekend of ingetrokken geheim: null.
--
-- Het bereik is dat van de eigenaar zoals het nú in app_users staat, niet
-- zoals het was toen het abonnement gemaakt werd: wie een product verliest,
-- verliest het bij de volgende ophaalbeurt ook in zijn agenda. Van dertig
-- dagen geleden af, zodat een moment dat te laat is zichtbaar blijft tot
-- iemand het afvinkt. Enkel geplande momenten, geen logboek.
create or replace function public.calendar_feed(p_secret text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_feed  public.calendar_feeds;
  v_scope text[];
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into v_feed from public.calendar_feeds where secret_hash = followup.feed_hash(p_secret);
  if not found then
    return null;
  end if;
  update public.calendar_feeds set last_used = now() where id = v_feed.id;
  select products into v_scope from public.app_users where id = v_feed.owner;

  return jsonb_build_object(
    'label',  v_feed.label,
    'lang',   v_feed.lang,
    'events', followup.feed_events(
                (select s.data from public.app_state s where s.id = 'main'),
                coalesce(v_scope, '{}'), v_feed.owner, v_feed.mine, v_feed.products,
                to_char(current_date - 30, 'YYYY-MM-DD')));
end $$;

-- Vier deuren, en alleen deze. calendar_feed is de enige die anon mag: de
-- agenda-app heeft geen aanmelding. Wat die deur doorlaat, beslist het geheim.
revoke all on function public.feed_create(text, boolean, text[], text) from public, anon;
revoke all on function public.feed_list(boolean) from public, anon;
revoke all on function public.feed_remove(uuid) from public, anon;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.feed_create(text, boolean, text[], text) to authenticated;
grant execute on function public.feed_list(boolean) to authenticated;
grant execute on function public.feed_remove(uuid) to authenticated;
grant execute on function public.calendar_feed(text) to anon, authenticated;
