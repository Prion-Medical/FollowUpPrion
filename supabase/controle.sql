-- FollowUp Prion – controle op de productafscherming
--
-- Voer dit uit in Supabase → SQL Editor, ná supabase/schema.sql. Het raakt
-- app_state niet aan: deel A rekent met een testdocument in het geheugen.
-- Elke regel zegt zelf OK of FOUT; je hoeft niets te vergelijken.
--
-- Staat er ergens FOUT, schakel de app dan NIET om naar read_state /
-- write_state: dan gooit een opslag door een beperkte gebruiker gegevens weg
-- van het andere product.

-- ===========================================================================
--  DEEL A — afschermen, samenvoegen en stempelen, zonder de tabel
-- ===========================================================================
with doc as (select $j${
  "version": 1,
  "_note": "testdocument",
  "targets": { "2026": { "EndoQ": 10, "Ainex": 4 } },
  "hospitals": [
    { "id": "h1", "name": "UZ Gedeeld", "products": ["EndoQ", "Ainex"],
      "status": "orange", "stage": "meeting", "country": "BE", "sector": "university",
      "address": "", "notes": "", "lat": 50.8, "lng": 4.6, "createdAt": "2026-01-01",
      "nextAction": "bellen", "nextActionDate": "2026-01-10",
      "unit": { "rooms": 4, "roomsDemo": 3 },
      "contacts": [
        { "id": "c1", "name": "Dr EndoQ", "product": "EndoQ" },
        { "id": "c2", "name": "Dr Ainex", "product": "Ainex" },
        { "id": "c3", "name": "Aankoop",  "product": "" },
        { "id": "c6", "name": "Dr Allebei", "products": ["EndoQ", "Ainex"] } ],
      "activities": [
        { "id": "a1", "date": "2026-01-02", "type": "call",  "product": "EndoQ", "note": "",
          "createdBy": "U1", "createdAt": "2026-01-02", "updatedBy": "U1", "updatedAt": "2026-01-02" },
        { "id": "a2", "date": "2026-01-03", "type": "visit", "product": "Ainex", "note": "",
          "createdBy": "U1", "createdAt": "2026-01-03", "updatedBy": "U1", "updatedAt": "2026-01-03" },
        { "id": "a3", "date": "2026-01-04", "type": "email", "product": "", "note": "" },
        { "id": "a4", "date": "2026-03-01", "type": "demo",  "product": "EndoQ", "rooms": 3, "note": "" },
        { "id": "a5", "date": "2026-02-01", "type": "demo",  "product": "Ainex", "rooms": 1, "note": "" } ],
      "planned": [
        { "id": "p1", "date": "2026-01-10", "type": "call",  "product": "EndoQ", "note": "bellen" },
        { "id": "p2", "date": "2026-02-20", "type": "visit", "product": "Ainex", "note": "langsgaan" } ] },
    { "id": "h2", "name": "AZ EndoQ", "products": ["EndoQ"],
      "nextAction": "", "nextActionDate": "", "unit": {},
      "contacts": [ { "id": "c4", "name": "Dr Twee", "product": "EndoQ" } ],
      "activities": [], "planned": [] },
    { "id": "h3", "name": "ZH Niemand", "products": [],
      "nextAction": "", "nextActionDate": "", "unit": {},
      "contacts": [ { "id": "c5", "name": "Onbekend", "product": "" } ],
      "activities": [], "planned": [] },
    { "id": "h4", "name": "ZH Zonder vinkje", "products": [],
      "nextAction": "", "nextActionDate": "", "unit": {},
      "contacts": [],
      "activities": [
        { "id": "a6", "date": "2026-01-05", "type": "call", "product": "EndoQ", "note": "" } ],
      "planned": [] }
  ]}$j$::jsonb as d),

-- Het beeld van een Ainex-gebruiker.
mijn as (select d, followup.scope_doc(d, '{Ainex}'::text[]) as s from doc),

-- Dezelfde gebruiker slaat op zonder iets te wijzigen.
rondgang as (select d, followup.merge_doc(d, s, '{Ainex}'::text[], false) as n from mijn),

-- En hier wijzigt hij wél iets: hij verbetert het telefoonnummer van zijn
-- contact, voegt een contactmoment toe en vinkt zijn planning p2 af (p2 gaat
-- weg en komt terug als contactmoment met hetzelfde id).
gewijzigd as (
  select d, followup.merge_doc(d, jsonb_set(jsonb_set(jsonb_set(s,
           '{hospitals,0,contacts,0,phone}', '"+32 11 22 33"'),
           '{hospitals,0,activities}', (s #> '{hospitals,0,activities}') ||
             '[{"id":"n1","date":"2026-04-01","type":"call","product":"Ainex","note":"nieuw"},
               {"id":"p2","date":"2026-02-20","type":"visit","product":"Ainex","note":"langsgaan"}]'::jsonb),
           '{hospitals,0,planned}', '[]'::jsonb),
         '{Ainex}'::text[], false) as n
  from mijn),

-- En hier zet hij alle productvinkjes van Dr Allebei uit. Hij ziet er maar
-- één staan, dus het EndoQ-vinkje mag daar niet mee sneuvelen: dat is niet
-- van hem. Index 2 is c6 in zijn beeld — c1 valt weg, dus c2, c3, c6.
strippen as (
  select d, followup.merge_doc(d,
           jsonb_set(s, '{hospitals,0,contacts,2,products}', '[]'::jsonb),
         '{Ainex}'::text[], false) as n
  from mijn)

select nr, controle,
       case when verwacht is not distinct from gekregen then 'OK' else '>>> FOUT' end as uitslag,
       verwacht, gekregen
from (
  -- --- lezen -------------------------------------------------------------
  select 1, 'elk ziekenhuis blijft zichtbaar, ook zonder vinkje',
         '["h1", "h2", "h3", "h4"]'::jsonb,
         (select jsonb_agg(h ->> 'id') from jsonb_array_elements(s -> 'hospitals') h) from mijn
  union all select 2, 'products is gesnoeid op het bereik',
         '["Ainex"]'::jsonb, s #> '{hospitals,0,products}' from mijn
  union all select 3, 'contactpersonen: eigen product, zonder product, en beide',
         '["c2", "c3", "c6"]'::jsonb,
         (select jsonb_agg(c ->> 'id') from jsonb_array_elements(s #> '{hospitals,0,contacts}') c) from mijn
  union all select 4, 'contactmomenten: EndoQ valt weg',
         '["a2", "a3", "a5"]'::jsonb,
         (select jsonb_agg(a ->> 'id') from jsonb_array_elements(s #> '{hospitals,0,activities}') a) from mijn
  union all select 5, 'geplande momenten: enkel het eigen',
         '["p2"]'::jsonb,
         (select jsonb_agg(p ->> 'id') from jsonb_array_elements(s #> '{hospitals,0,planned}') p) from mijn
  union all select 6, 'doelcijfers: enkel het eigen product',
         '{"2026": {"Ainex": 4}}'::jsonb, s -> 'targets' from mijn
  union all select 7, 'onbeperkt krijgt het document ongewijzigd',
         to_jsonb(true), to_jsonb(followup.scope_doc(d, '{}'::text[]) = d) from doc

  -- --- de belangrijkste controle -----------------------------------------
  -- Laden en ongewijzigd terugsturen moet exact hetzelfde document opleveren.
  -- Komt hier FOUT, dan gooit elke opslag door een Ainex-gebruiker iets weg.
  union all select 8, 'rondgang: laden en opslaan verandert niets',
         to_jsonb(true), to_jsonb(n = d) from rondgang
  union all select 9, 'rondgang: de EndoQ-contactmomenten staan er nog',
         '["a1", "a2", "a3", "a4", "a5"]'::jsonb,
         (select jsonb_agg(a ->> 'id') from jsonb_array_elements(n #> '{hospitals,0,activities}') a) from rondgang
  union all select 10, 'rondgang: de EndoQ-contactpersoon is onaangeroerd',
         '["c1", "c2", "c3", "c6"]'::jsonb,
         (select jsonb_agg(c ->> 'id') from jsonb_array_elements(n #> '{hospitals,0,contacts}') c) from rondgang
  union all select 11, 'rondgang: het EndoQ-ziekenhuis bestaat nog',
         '["h1", "h2", "h3", "h4"]'::jsonb,
         (select jsonb_agg(h ->> 'id') from jsonb_array_elements(n -> 'hospitals') h) from rondgang

  -- --- een echte wijziging ------------------------------------------------
  union all select 12, 'wijziging: het eigen contact is bijgewerkt',
         '"+32 11 22 33"'::jsonb, n #> '{hospitals,0,contacts,1,phone}' from gewijzigd
  union all select 13, 'wijziging: het EndoQ-contact kreeg geen telefoonnummer',
         to_jsonb(false), to_jsonb((n #> '{hospitals,0,contacts,0}') ? 'phone') from gewijzigd
  union all select 14, 'wijziging: nieuw contactmoment en afgevinkte planning erbij',
         '["a1", "a2", "a3", "a4", "a5", "n1", "p2"]'::jsonb,
         (select jsonb_agg(a ->> 'id') from jsonb_array_elements(n #> '{hospitals,0,activities}') a) from gewijzigd
  union all select 15, 'wijziging: enkel de EndoQ-planning blijft staan',
         '["p1"]'::jsonb,
         (select jsonb_agg(p ->> 'id') from jsonb_array_elements(n #> '{hospitals,0,planned}') p) from gewijzigd
  union all select 16, 'wijziging: nextActionDate volgt uit de volledige planning',
         '"2026-01-10"'::jsonb, n #> '{hospitals,0,nextActionDate}' from gewijzigd
  union all select 17, 'wijziging: roomsDemo blijft van de laatste demo overall',
         '3'::jsonb, n #> '{hospitals,0,unit,roomsDemo}' from gewijzigd

  -- --- het andere product kan er niet af ----------------------------------
  union all select 18, 'Ainex kan zichzelf weghalen, EndoQ blijft staan',
         '["EndoQ"]'::jsonb,
         followup.merge_doc(d, jsonb_set(s, '{hospitals,0,products}', '[]'::jsonb),
                            '{Ainex}'::text[], false) #> '{hospitals,0,products}' from mijn

  -- --- de stempel ----------------------------------------------------------
  union all select 19, 'stempel: een nieuw contactmoment is van de aanroeper',
         '"U2"'::jsonb,
         (select e -> 'createdBy'
            from jsonb_array_elements(followup.stamp_doc(d, n, 'U2', '2026-11-07') #> '{hospitals,0,activities}') e
           where e ->> 'id' = 'n1') from gewijzigd
  union all select 20, 'stempel: een ongewijzigd contactmoment houdt zijn maker',
         '"U1"'::jsonb,
         (select e -> 'createdBy'
            from jsonb_array_elements(followup.stamp_doc(d, n, 'U2', '2026-11-07') #> '{hospitals,0,activities}') e
           where e ->> 'id' = 'a1') from gewijzigd
  union all select 21, 'stempel: een ongewijzigd contactmoment houdt zijn datum',
         '"2026-01-02"'::jsonb,
         (select e -> 'updatedAt'
            from jsonb_array_elements(followup.stamp_doc(d, n, 'U2', '2026-11-07') #> '{hospitals,0,activities}') e
           where e ->> 'id' = 'a1') from gewijzigd
  union all select 22, 'stempel: bij een gewijzigd record blijft de maker staan',
         '["U1", "U2"]'::jsonb,
         (select jsonb_build_array(e -> 'createdBy', e -> 'updatedBy')
            from jsonb_array_elements(followup.stamp_doc(d,
                   jsonb_set(d, '{hospitals,0,activities,0,note}', '"aangepast"'),
                   'U2', '2026-11-07') #> '{hospitals,0,activities}') e
           where e ->> 'id' = 'a1') from doc
  union all select 23, 'stempel: een oud record krijgt er geen verzonnen maker bij',
         to_jsonb(false),
         (select to_jsonb(e ? 'createdBy')
            from jsonb_array_elements(followup.stamp_doc(d, d, 'U2', '2026-11-07') #> '{hospitals,0,activities}') e
           where e ->> 'id' = 'a3') from doc
  union all select 24, 'stempel: stempelen verandert verder niets aan het document',
         to_jsonb(true),
         to_jsonb(followup.stamp_doc(d, d, 'U2', '2026-11-07') = d) from doc

  -- --- roomsDemo: herrekenen mag, overschrijven niet ----------------------
  -- Het veld staat ook met de hand in de fiche. Rekende de server het bij elke
  -- opslag opnieuw uit, dan was een ingetypt getal elke keer weg.
  union all select 25, 'roomsDemo: een ingetypt getal blijft staan als geen demo veranderde',
         '9'::jsonb,
         followup.merge_doc(d, jsonb_set(s, '{hospitals,0,unit,roomsDemo}', '9'::jsonb),
                            '{Ainex}'::text[], false) #> '{hospitals,0,unit,roomsDemo}' from mijn
  -- s heeft de contactmomenten a2, a3 en a5; nummer 2 is de Ainex-demo a5.
  union all select 26, 'roomsDemo: wie zijn eigen demo aanpast, overschrijft die van EndoQ niet',
         '3'::jsonb,
         followup.merge_doc(d, jsonb_set(s, '{hospitals,0,activities,2,rooms}', '2'::jsonb),
                            '{Ainex}'::text[], false) #> '{hospitals,0,unit,roomsDemo}' from mijn

  -- --- doelcijfers bij het opslaan ----------------------------------------
  union all select 27, 'doelcijfer: Ainex past het zijne aan, dat van EndoQ blijft',
         '{"2026": {"EndoQ": 10, "Ainex": 7}}'::jsonb,
         followup.merge_doc(d, jsonb_set(s, '{targets,2026,Ainex}', '7'::jsonb),
                            '{Ainex}'::text[], false) -> 'targets' from mijn

  -- --- het ziekenhuis zonder vinkje ----------------------------------------
  -- h4 draagt geen enkel product, maar wel een EndoQ-contactmoment. Het is dus
  -- zichtbaar voor iedereen terwijl de inhoud wel degelijk afgeschermd blijft.
  union all select 28, 'zonder vinkje: het EndoQ-contactmoment valt weg bij het lezen',
         '[]'::jsonb, s #> '{hospitals,3,activities}' from mijn
  union all select 29, 'zonder vinkje: na een rondgang staat dat contactmoment er nog',
         '["a6"]'::jsonb,
         (select jsonb_agg(a ->> 'id') from jsonb_array_elements(n #> '{hospitals,3,activities}') a) from rondgang
  union all select 30, 'nextAction is de nota van het eigen geplande moment',
         '"langsgaan"'::jsonb, s #> '{hospitals,0,nextAction}' from mijn
  union all select 31, 'nextActionDate volgt mee, niet die van het EndoQ-moment',
         '"2026-02-20"'::jsonb, s #> '{hospitals,0,nextActionDate}' from mijn

  -- --- een contactpersoon met meerdere producten ---------------------------
  -- Dezelfde arts doet vaak EndoQ én Ainex. Hij blijft zichtbaar zodra er één
  -- product overlapt, maar het vinkje van de collega hoort hij niet te zien en
  -- al helemaal niet te kunnen uitzetten.
  union all select 32, 'contactpersoon met beide producten: enkel het eigen vinkje komt door',
         '["Ainex"]'::jsonb, s #> '{hospitals,0,contacts,2,products}' from mijn
  union all select 33, 'de oude vorm met één product wordt bij het lezen niet omgezet',
         to_jsonb(true), to_jsonb((s #> '{hospitals,0,contacts,0}') ? 'product') from mijn
  union all select 34, 'rondgang: het EndoQ-vinkje van die contactpersoon blijft staan',
         '["EndoQ", "Ainex"]'::jsonb,
         (select c -> 'products' from jsonb_array_elements(n #> '{hospitals,0,contacts}') c
           where c ->> 'id' = 'c6') from rondgang
  union all select 35, 'Ainex kan het EndoQ-vinkje van een contactpersoon niet wegnemen',
         '["EndoQ"]'::jsonb,
         (select c -> 'products' from jsonb_array_elements(n #> '{hospitals,0,contacts}') c
           where c ->> 'id' = 'c6') from strippen
) q(nr, controle, verwacht, gekregen)
order by nr;


-- ===========================================================================
--  DEEL B — wat moet mislukken
-- ===========================================================================
-- Voer deze één voor één uit: haal de /* en */ rond één blok weg, voer het uit,
-- zet ze terug. Elk van de eerste zes hoort te mislukken met de melding die
-- erboven staat — de tekst begint met "followup:" en daarachter de sleutel.
-- Komt er geen fout, dan laat dat blok iets door wat het moest tegenhouden.
--
-- Deze blokken rekenen met een testdocument in de query zelf, net als deel A.
-- Ze lezen app_state niet en schrijven niets.

-- 1. PT403 out_of_scope — een contactmoment op het andere product zetten.
--    Het Ainex-beeld van h1 heeft één contactmoment, a2; dat op "EndoQ" zetten
--    is een product wegschrijven dat deze gebruiker niet mag.
/*
with x as (select $j$
    {"version": 1, "hospitals": [
      { "id": "h1", "name": "UZ Gedeeld", "products": ["EndoQ", "Ainex"], "unit": {},
        "contacts": [ { "id": "c1", "name": "Dr EndoQ", "product": "EndoQ" },
                      { "id": "c2", "name": "Dr Ainex", "product": "Ainex" } ],
        "activities": [ { "id": "a1", "date": "2026-01-02", "type": "call",  "product": "EndoQ" },
                        { "id": "a2", "date": "2026-01-03", "type": "visit", "product": "Ainex" } ],
        "planned": [] } ]}$j$::jsonb as d)
select followup.merge_doc(d,
         jsonb_set(followup.scope_doc(d, '{Ainex}'::text[]),
                   '{hospitals,0,activities,0,product}', '"EndoQ"'),
         '{Ainex}'::text[], false)
  from x;
*/

-- 2. PT403 no_delete — een aanvuller laat een ziekenhuis weg uit zijn payload.
/*
with x as (select $j$
    {"version": 1, "hospitals": [
      { "id": "h1", "name": "UZ Gedeeld", "products": ["EndoQ", "Ainex"], "unit": {},
        "contacts": [ { "id": "c1", "name": "Dr EndoQ", "product": "EndoQ" },
                      { "id": "c2", "name": "Dr Ainex", "product": "Ainex" } ],
        "activities": [ { "id": "a1", "date": "2026-01-02", "type": "call",  "product": "EndoQ" },
                        { "id": "a2", "date": "2026-01-03", "type": "visit", "product": "Ainex" } ],
        "planned": [] } ]}$j$::jsonb as d)
select followup.merge_doc(d,
         jsonb_set(followup.scope_doc(d, '{Ainex}'::text[]),
                   '{hospitals}', '[]'::jsonb),
         '{Ainex}'::text[], false)
  from x;
*/

-- 3. PT403 out_of_scope — een bewerker mág verwijderen (laatste argument true),
--    maar niet een ziekenhuis waar EndoQ ook aan werkt. Dat is niet zijn
--    beslissing alleen.
/*
with x as (select $j$
    {"version": 1, "hospitals": [
      { "id": "h1", "name": "UZ Gedeeld", "products": ["EndoQ", "Ainex"], "unit": {},
        "contacts": [ { "id": "c1", "name": "Dr EndoQ", "product": "EndoQ" },
                      { "id": "c2", "name": "Dr Ainex", "product": "Ainex" } ],
        "activities": [ { "id": "a1", "date": "2026-01-02", "type": "call",  "product": "EndoQ" },
                        { "id": "a2", "date": "2026-01-03", "type": "visit", "product": "Ainex" } ],
        "planned": [] } ]}$j$::jsonb as d)
select followup.merge_doc(d,
         jsonb_set(followup.scope_doc(d, '{Ainex}'::text[]),
                   '{hospitals}', '[]'::jsonb),
         '{Ainex}'::text[], true)
  from x;
*/

-- 4. PT422 invalid_payload — contacts is geen lijst. Verderop zouden we dat
--    als "leeg" lezen, en dat is hetzelfde als "alles verwijderd".
/*
select followup.check_payload('{"hospitals":[{"id":"h1","contacts":{}}]}'::jsonb);
*/

-- 5. PT422 duplicate_id — hetzelfde id twee keer maakt samenvoegen onbeslisbaar.
/*
select followup.check_payload('{"hospitals":[{"id":"h1"},{"id":"h1"}]}'::jsonb);
*/

-- 6. PT403 out_of_scope — een ziekenhuis zonder vinkje weggooien terwijl er
--    een contactmoment van het andere product in zit. Het vinkje alleen zou
--    dit doorlaten: [] valt binnen elk bereik. De inhoud houdt het tegen.
/*
with x as (select $j$
    {"version": 1, "hospitals": [
      { "id": "h4", "name": "ZH Zonder vinkje", "products": [], "unit": {},
        "contacts": [], "planned": [],
        "activities": [
          { "id": "a6", "date": "2026-01-05", "type": "call", "product": "EndoQ" } ] } ]}$j$::jsonb as d)
select followup.merge_doc(d,
         jsonb_set(followup.scope_doc(d, '{Ainex}'::text[]), '{hospitals}', '[]'::jsonb),
         '{Ainex}'::text[], true)
  from x;
*/

-- 7. En één die juist moet lukken: een ziekenhuis zonder contacts, activities
--    of planned is geldig — zo staat het in data/seed.json. Dit blok hoort
--    géén fout te geven; het antwoord is een lege kolom check_payload.
/*
select followup.check_payload('{"hospitals":[{"id":"h9","name":"Nieuw"}]}'::jsonb);
*/


-- ===========================================================================
--  DEEL C — echt door read_state en write_state, met een echte gebruiker
-- ===========================================================================
-- In de SQL-editor is auth.uid() leeg, dus doen we een gebruiker na. Alles in
-- één transactie met rollback: er blijft niets van over.
--
-- Vul eerst het uuid in van een gebruiker met products = {Ainex}:
--   select u.id, u.email, a.role, a.products
--     from auth.users u join public.app_users a on a.id = u.id;

-- C1 — de muur. Deze drie moeten elk mislukken met "permission denied". Voer
-- ze één per keer uit, elk als een eigen blok: de eerste fout zet een transactie
-- in zijn geheel stil, en in één blok zou alleen de eerste regel nog iets
-- zeggen. Vul in elk blok eerst het uuid in.

/*
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PLAK-HIER-HET-UUID","role":"authenticated"}';
  select count(*) from public.app_state;            -- moet mislukken
rollback;
*/

/*
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PLAK-HIER-HET-UUID","role":"authenticated"}';
  select count(*) from public.app_state_backups;    -- moet mislukken
rollback;
*/

/*
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PLAK-HIER-HET-UUID","role":"authenticated"}';
  select followup.my_role();                        -- moet mislukken
rollback;
*/

-- C2 — de rondgang langs de echte functies. Twee blokken, want de SQL-editor
-- toont enkel het resultaat van de laatste select: in één blok zag je de
-- vergelijking wel en de cijfers niet.

-- C2a — wat deze gebruiker te zien krijgt. rol en bereik moeten kloppen met
-- zijn rij in app_users, en "ziekenhuizen" is kleiner dan het totaal.

/*
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PLAK-HIER-HET-UUID","role":"authenticated"}';
  select public.read_state() -> 'role'     as rol,
         public.read_state() -> 'products' as bereik,
         jsonb_array_length(public.read_state() -> 'data' -> 'hospitals') as ziekenhuizen;
rollback;
*/

-- C2b — laden en ongewijzigd terugsturen. Dit zegt zelf OK of FOUT: het
-- document mag er geen byte anders van worden. updated_by hoort daarna de
-- nagedane gebruiker te zijn — de stempel komt van de databank, niet van de
-- client. Alles staat in één transactie met rollback, dus er blijft niets van
-- over. (Werkt alleen als er al een rij 'main' staat; op een leeg project
-- maakt write_state die aan en zegt deze controle FOUT zonder dat er iets mis
-- is.)

/*
begin;
  create temp table ctrl on commit drop as
    select md5(data::text) as voor from public.app_state where id = 'main';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PLAK-HIER-HET-UUID","role":"authenticated"}';

  select public.write_state(public.read_state() -> 'data',
                            (public.read_state() ->> 'updated_at')::timestamptz);

  reset role;

  select case when (select voor from ctrl)
                 = (select md5(data::text) from public.app_state where id = 'main')
              then 'OK' else '>>> FOUT' end                                as rondgang,
         (select updated_by from public.app_state where id = 'main')       as updated_by;
rollback;
*/
