-- FollowUp Prion – staan de deuren nog dicht?
--
-- Voer dit uit in Supabase → SQL Editor. Alleen lezen; het wijzigt niets.
-- Elke regel zegt zelf OK of FOUT.
--
-- Dit controleert wat in de databank staat. Twee dingen staan er NIET in en
-- kan deze query dus ook niet zien — die blijven een kwestie van het
-- dashboard, en ze staan onderaan herhaald:
--   * staat aanmelden uit (Authentication → Sign In / Providers)
--   * staat 2FA aan op de accounts die aan het dashboard kunnen

select nr, controle,
       case when gekregen = verwacht then 'OK' else '>>> FOUT' end as uitslag,
       verwacht, gekregen
from (
  -- --- de datatabel is onbereikbaar via de API ------------------------------
  -- Niet de rij-beveiliging maar de grants doen dit werk: zonder select kan
  -- een aangemelde gebruiker de tabel niet eens proberen te lezen.
  select 1, 'app_state: authenticated mag niet lezen', false,
         has_table_privilege('authenticated', 'public.app_state', 'select')
  union all select 2, 'app_state: authenticated mag niet schrijven', false,
         has_table_privilege('authenticated', 'public.app_state', 'update')
  union all select 3, 'app_state: anon mag niets', false,
         has_table_privilege('anon', 'public.app_state', 'select')

  -- --- de dagkopieën helemaal dicht ----------------------------------------
  -- Die bevatten het volledige document zonder afscherming. Eén grant hier
  -- en de productmuur heeft een deur ernaast.
  union all select 4, 'app_state_backups: authenticated mag niet lezen', false,
         has_table_privilege('authenticated', 'public.app_state_backups', 'select')
  union all select 5, 'app_state_backups: anon mag niet lezen', false,
         has_table_privilege('anon', 'public.app_state_backups', 'select')

  -- --- de rekenhulpjes blijven binnenskamers -------------------------------
  -- PostgREST maakt van elke functie in public een /rpc/-adres. Alles wat in
  -- followup staat is daarmee onbereikbaar, zolang niemand usage krijgt.
  union all select 6, 'schema followup: authenticated heeft geen usage', false,
         has_schema_privilege('authenticated', 'followup', 'usage')
  union all select 7, 'schema followup: anon heeft geen usage', false,
         has_schema_privilege('anon', 'followup', 'usage')

  -- --- de drie deuren die wél open horen te staan --------------------------
  union all select 8, 'read_state: authenticated mag uitvoeren', true,
         has_function_privilege('authenticated', 'public.read_state()', 'execute')
  union all select 9, 'write_state: authenticated mag uitvoeren', true,
         has_function_privilege('authenticated', 'public.write_state(jsonb, timestamptz, text)', 'execute')
  union all select 10, 'read_state: anon mag niet uitvoeren', false,
         has_function_privilege('anon', 'public.read_state()', 'execute')
  -- Het tijdstip van de laatste opslag, voor het stille herladen in de app.
  union all select 20, 'state_version: authenticated mag uitvoeren', true,
         has_function_privilege('authenticated', 'public.state_version()', 'execute')
  union all select 21, 'state_version: anon mag niet uitvoeren', false,
         has_function_privilege('anon', 'public.state_version()', 'execute')

  -- --- rij-beveiliging staat aan -------------------------------------------
  -- Het vangnet onder de grants: ook een rol die de tabel wél mag zien, komt
  -- niet langs een policy heen.
  union all select 11, 'app_state: rij-beveiliging aan', true,
         (select relrowsecurity from pg_class where oid = 'public.app_state'::regclass)
  union all select 12, 'app_state_backups: rij-beveiliging aan', true,
         (select relrowsecurity from pg_class where oid = 'public.app_state_backups'::regclass)
  union all select 13, 'app_users: rij-beveiliging aan', true,
         (select relrowsecurity from pg_class where oid = 'public.app_users'::regclass)

  -- --- app_users: lezen mag, wijzigen enkel voor een beheerder -------------
  union all select 14, 'app_users: authenticated mag lezen', true,
         has_table_privilege('authenticated', 'public.app_users', 'select')
  union all select 15, 'app_users: niemand mag rijen verwijderen via de API', false,
         has_table_privilege('authenticated', 'public.app_users', 'delete')
  union all select 16, 'app_users: er staat een policy op wijzigen', true,
         exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'app_users' and cmd = 'UPDATE')

  -- --- elke gebruiker heeft een rij, en er is een beheerder ----------------
  -- Zonder rij val je terug op viewer; zonder beheerder kan niemand nog een
  -- rol toekennen.
  union all select 17, 'elke aangemelde gebruiker heeft een app_users-rij', true,
         (select count(*) from auth.users) = (select count(*) from public.app_users)
  union all select 18, 'er is minstens één beheerder', true,
         exists (select 1 from public.app_users where role = 'admin')
  union all select 19, 'de trigger die een rij aanmaakt bestaat nog', true,
         exists (select 1 from pg_trigger where tgname = 'app_user_create' and not tgisinternal)

  -- --- agenda-abonnementen --------------------------------------------------
  -- De tabel is onbereikbaar, net als app_state: wie hem kan lezen, ziet van
  -- wie elk abonnement is. calendar_feed is de enige deur die anon mag, en
  -- die beslist met het geheim; de andere drie zijn voor wie aangemeld is.
  union all select 22, 'calendar_feeds: authenticated mag niet lezen', false,
         has_table_privilege('authenticated', 'public.calendar_feeds', 'select')
  union all select 23, 'calendar_feeds: anon mag niet lezen', false,
         has_table_privilege('anon', 'public.calendar_feeds', 'select')
  union all select 24, 'calendar_feeds: niemand mag schrijven via de API', false,
         has_table_privilege('authenticated', 'public.calendar_feeds', 'insert')
      or has_table_privilege('authenticated', 'public.calendar_feeds', 'update')
      or has_table_privilege('authenticated', 'public.calendar_feeds', 'delete')
      or has_table_privilege('anon', 'public.calendar_feeds', 'insert')
      or has_table_privilege('anon', 'public.calendar_feeds', 'update')
      or has_table_privilege('anon', 'public.calendar_feeds', 'delete')
  union all select 25, 'calendar_feeds: rij-beveiliging aan', true,
         (select relrowsecurity from pg_class where oid = 'public.calendar_feeds'::regclass)
  union all select 26, 'calendar_feeds: geen enkele policy', false,
         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'calendar_feeds')
  union all select 27, 'calendar_feed: anon mag uitvoeren (de agenda-app)', true,
         has_function_privilege('anon', 'public.calendar_feed(text)', 'execute')
  union all select 28, 'feed_create, feed_list, feed_remove: anon mag niet', false,
         has_function_privilege('anon', 'public.feed_create(text, boolean, text[], text)', 'execute')
      or has_function_privilege('anon', 'public.feed_list(boolean)', 'execute')
      or has_function_privilege('anon', 'public.feed_remove(uuid)', 'execute')
  union all select 29, 'feed_create, feed_list, feed_remove: authenticated mag', true,
         has_function_privilege('authenticated', 'public.feed_create(text, boolean, text[], text)', 'execute')
     and has_function_privilege('authenticated', 'public.feed_list(boolean)', 'execute')
     and has_function_privilege('authenticated', 'public.feed_remove(uuid)', 'execute')
  -- Een abonnement verdwijnt met zijn account. Zonder cascade blijft het adres
  -- werken voor iemand die er niet meer is, of blokkeert het verwijderen.
  union all select 30, 'calendar_feeds: verdwijnt met het account (cascade)', true,
         exists (select 1 from pg_constraint
                  where conrelid = 'public.calendar_feeds'::regclass and contype = 'f'
                    and confrelid = 'public.app_users'::regclass and confdeltype = 'c')

  -- --- het opgeslagen document --------------------------------------------
  -- check_payload() weigert een id met een stuurteken (een regeleinde, een
  -- tab). De app maakt zo'n id nooit; staat er toch een in het opgeslagen
  -- document, dan stuurt elke opslag het mee terug en weigert de databank
  -- voortaan elke opslag, van iedereen. Vóór schema.sql op live gaat, en
  -- daarna af en toe.
  union all select 31, 'geen id met een stuurteken in het opgeslagen document', false,
         exists (select 1 from unnest(followup.doc_keys((select data from public.app_state where id = 'main'))) k
                  where k ~ '[[:cntrl:]]')
) q(nr, controle, verwacht, gekregen)
order by nr;


-- Wie er zijn en wat ze mogen. Geen controle, gewoon om naar te kijken:
-- staat hier iemand die er niet hoort, of iemand op admin die dat niet
-- hoeft te zijn?
select u.email,
       a.name,
       a.role,
       case when a.products = '{}' then 'alles' else array_to_string(a.products, ', ') end as bereik,
       u.last_sign_in_at
  from auth.users u
  left join public.app_users a on a.id = u.id
 order by a.role, u.email;


-- Niet in SQL te zien, wél belangrijk — kijk dit in het dashboard na:
--   1. Authentication → Sign In / Providers: "Allow new users to sign up"
--      moet UIT staan. Anders maakt iedereen met de anon-sleutel een account,
--      en die sleutel staat in config.js, dus publiek.
--   2. 2FA aan op elk account dat aan het dashboard kan. Daar hangt de
--      service-sleutel achter, en die omzeilt alles wat hierboven staat.
--   3. De service-sleutel hoort nergens in de repo of in een browser.
--   4. Voor de koppeling met een assistent, onder Authentication → OAuth
--      Server en OAuth Apps: "dynamic client registration" UIT, en precies
--      één geregistreerde aanvrager (Claude) met alleen de twee adressen van
--      claude.ai en claude.com als redirect. De toestemmingspagina vertrouwt
--      op de naam en het terugkeeradres die Supabase voor die aanvrager
--      teruggeeft; een tweede aanvrager is een tweede deur.
--   5. Edge Functions: "Verify JWT" staat alleen UIT voor de functies agent
--      en calendar. agent kijkt de sleutel zelf na; calendar heeft er geen
--      nodig, want een agenda-app meldt zich niet aan en het geheim in het
--      adres beslist (zie calendar_feed). Elke andere functie hoort hem aan
--      te laten staan.
