-- FollowUp Prion – draait de databank de huidige schema.sql?
--
-- Voer dit uit in Supabase → SQL Editor, ná supabase/schema.sql en vóór
-- supabase/controle.sql. Het leest alleen pg_proc en raakt niets aan.
--
-- Waarom dit bestaat. schema.sql bestaat volledig uit "create or replace".
-- Voer je per ongeluk een óudere kopie uit — een tabblad in de SQL-editor dat
-- nog openstond, bijvoorbeeld — dan draait dat zonder fout en zet het functies
-- stil terug naar die oudere versie. Zelfs een reparatie die er al in stond.
-- Dat is drie keer na elkaar gebeurd. Het valt pas op in controle.sql, en dan
-- alleen aan de nieuwste controles: alles wat ouder is blijft gewoon slagen.
--
-- Kopieer het bestand daarom van schijf in plaats van uit een tabblad:
--
--     pbcopy < supabase/schema.sql
--
-- en kijk hier na of het echt aangekomen is.
--
-- Hoe het werkt: per functie één woord dat in de nieuwste versie van die
-- functie voorkomt en in de vorige niet. Staat het er niet in, dan draait er
-- een oudere versie. Komt er een functie bij, of verandert er een wezenlijk,
-- zet hem er dan hieronder bij met zo'n woord — anders bewaakt deze lijst
-- stilaan niets meer.

with verwacht(functie, moet_bevatten, waarvoor) as (values
  ('scope_hospital',  'fix_planned',    'nextAction van het andere product niet meesturen'),
  ('scope_hospital',  'scope_entries(h -> ''contacts''', 'de productlijst van een contactpersoon afschermen'),
  -- Deze is de belangrijkste van de lijst. Draait er nog een oude in_scope,
  -- dan kijkt die enkel naar "product" en leest ze een contactpersoon met een
  -- "products"-lijst als "heeft geen product" — en dan is die voor iedereen
  -- zichtbaar. Dat is het ene geval waarin een stille terugval niet alleen
  -- iets stukmaakt maar iets lekt.
  ('in_scope',        'both_in',        'een contactpersoon met een productlijst afschermen'),
  -- Sorteert product_sort nog met een vaste lijst in plaats van met
  -- producten(), dan verandert een nieuw product daar niets meer aan.
  ('product_sort',    'producten',      'de productenlijst komt uit één functie'),
  ('merge_entries',   'merge_products', 'het vinkje van de collega niet laten wegnemen'),
  ('merge_products',  'only_in',        'bestaat die functie überhaupt'),
  ('merge_hospital',  'merge_products', 'dezelfde formule voor het ziekenhuis'),
  ('merge_doc',       'merge_entries',  'een nieuw ziekenhuis gaat door dezelfde regels'),
  ('producten',       'Fibroid RFA',    'de productenlijst kent de RFA-producten'),
  ('producten',       'Stents',         'de productenlijst kent stents'),
  -- Een moment kan over meer dan één product gaan. Snoeit scope_entries die
  -- lijst niet, dan leest wie afgeschermd is het product van de collega mee.
  ('scope_entries',   'both_in',        'de productlijst van een moment afschermen'),
  -- De opvolging per product. Draait er nog een oude scope_hospital, dan gaat
  -- de fase en de verantwoordelijke van het andere product gewoon mee naar
  -- een browser die ze niet mag zien.
  ('scope_hospital',  'scope_pipeline', 'de opvolging van het andere product niet meesturen'),
  ('scope_hospital',  'fix_overall',    'de kleur van het ziekenhuis verklapt het andere product niet'),
  ('merge_hospital',  'merge_pipeline', 'de opvolging van de collega niet laten overschrijven'),
  ('merge_doc',       'scope_pipeline', 'een nieuw ziekenhuis krijgt geen opvolging buiten het bereik'),
  ('vreemde_data',    'pipeline',       'een ziekenhuis met opvolging van een collega niet laten verwijderen'),
  ('fix_overall',     'fases',          'bestaat die functie überhaupt'),
  ('fases',           'purchasing',     'de fases aan de databankkant'),
  -- De omzetting van één fase per ziekenhuis naar een fase per product. Zonder
  -- deze drie maakt de eerste opslag van een afgeschermde gebruiker enkel zijn
  -- eigen rij aan en is de fase van het andere product daarna kwijt.
  ('opvolging_aanvullen', 'pipeline',       'bestaat die functie überhaupt'),
  ('read_state',      'opvolging_aanvullen', 'een oud document wordt omgezet vóór het afgeschermd wordt'),
  ('write_state',     'opvolging_aanvullen', 'een oud document wordt omgezet vóór het samengevoegd wordt'),
  -- Het stille herladen. Ontbreekt deze, dan werkt de app gewoon verder maar
  -- merkt ze een wijziging van een collega pas bij de eerstvolgende opslag.
  ('state_version',   'updated_at',     'de app kan vragen of er iets veranderd is'),
  -- Wat de sleutel van een assistent niet mag, ook al is de gebruiker
  -- beheerder of bewerker. Draait hier een oude versie, dan kan een gelekte
  -- sleutel gebruikers beheren en een back-up terugzetten.
  ('via_assistant',   'client_id',      'een sleutel van een assistent is te herkennen'),
  ('is_admin',        'via_assistant',  'gebruikers beheren kan niet met de sleutel van een assistent'),
  ('write_state',     'via_assistant',  'een back-up terugzetten kan niet met de sleutel van een assistent'),
  -- Agenda-abonnementen. Een feed_events zonder scope_doc toont een
  -- beperkt account de geplande momenten van elk product.
  ('feed_events',     'scope_doc',      'een abonnement gaat door dezelfde muur als de app'),
  ('feed_events',     'assignee',       '"voor mij" volgt wie gekozen is, anders wie het invoerde'),
  ('calendar_feed',   'feed_events',    'het abonnement leest via feed_events'),
  ('feed_create',     'via_assistant',  'een abonnement maakt een mens, geen assistent'),
  ('feed_remove',     'is_admin',       'een beheerder kan elk abonnement stopzetten'),
  ('feed_hash',       'sha256',         'bestaat die functie überhaupt'),
  -- Momenten zonder datum. Een oude fix_planned gooit ze bij elke opslag weg;
  -- een oude doc_keys laat een contributor ze ongezien verwijderen.
  ('fix_planned',     'order by coalesce(t.e ->> ''date''', 'een gepland moment zonder datum blijft staan'),
  ('fix_planned',     'coalesce(t.e ->> ''time'', ''99'')', 'op dezelfde dag op uur, zoals de agenda'),
  ('doc_keys',        'ook een gepland moment zonder datum', 'een moment zonder datum verwijderen is verwijderen'),
  -- Uit de veiligheidscontrole van 2026-11-13.
  ('check_payload',   '[[:cntrl:]]',    'een id met een regeleinde komt het document niet in'),
  ('feed_create',     'pg_advisory_xact_lock', 'het maximum aan abonnementen geldt ook bij gelijktijdige oproepen'),
  ('feed_list',       'via_assistant',  'een assistent ziet geen abonnementen'),
  ('feed_remove',     'via_assistant',  'een assistent zet geen abonnement stop'),
  -- Uit de review van 2026-11-13: momenten over meer producten.
  ('in_scope',        'products_of',    'de producten van een record via één functie'),
  ('merge_products',  'products_of',    'de productlijst van een record via één functie'),
  ('merge_entries',   'zonder_aantal',  'een moment over meer producten draagt geen aantal'),
  ('merge_entries',   'left join lateral', 'een afgevinkt plan geeft zijn producten, niet zijn plaats'),
  ('merge_hospital',  'afgevinkt',      'afvinken houdt het product van de collega op het contactmoment'),
  -- Issue 21: de databank beslist wat een contactmoment met de opvolging
  -- doet. Draait er een oude write_state, dan beweegt een moment dat via de
  -- koppeling binnenkomt niets meer: de koppeling rekent het niet meer zelf.
  ('write_state',     'opvolging_bijwerken_doc', 'een nieuw contactmoment verzet de opvolging en de kamers'),
  ('opvolging_bijwerken_doc', 'mode is distinct from ''save''', 'een import wordt niet opnieuw beslist'),
  ('opvolging_bijwerken', 'fix_rooms_installed', 'de kamers: opgeslagen getal plus het verschil'),
  ('opvolging_bijwerken', 'fix_pipeline',  'de rijen en wat een nieuw moment ermee doet'),
  ('opvolging_bijwerken', 'is distinct from (stored -> ''pipeline'')', 'een fase met de hand of een afgevinkt product: het ziekenhuis volgt'),
  ('fix_pipeline',    'soort_van',      'ook een moment waarvan de soort veranderde, gelezen zoals de app'),
  ('fix_pipeline',    'zonder_id_sleutel', 'een opgeslagen moment zonder id dat de app een id gaf, is niet nieuw'),
  ('fix_pipeline',    'v_pijp',         'lineair: de opvolging gaat als variabele door de lus'),
  ('fix_pipeline',    'not v_beperkt or x = any(allowed)', 'een beperkte opslag maakt geen rij voor de collega'),
  ('fix_pipeline',    'q.x = any(allowed)', 'een beperkte opslag verzet de rij van de collega niet'),
  ('fix_pipeline',    'v_naam && allowed', 'een moment buiten het bereik verzet niets'),
  ('fix_rooms_installed', 'geinstalleerd', 'de kamers: opgeslagen getal plus het verschil'),
  ('zonder_id_sleutel', 'datum_van',    'bestaat die functie überhaupt'),
  ('kent_fase',       'per_ingreep',    'bestaat die functie überhaupt'),
  ('soort_van',       'soorten',        'bestaat die functie überhaupt'),
  ('datum_van',       'jsonb_typeof(a -> ''date'')', 'een datum zoals dateOrEmpty() in de app'),
  ('geinstalleerd',   'count(distinct x)', 'een moment over meer producten telt geen kamers, een lijst van één wel'),
  ('write_state',     'v_basis',        'de regels vergelijken met hetzelfde omgezette document als het samenvoegen'),
  ('opvolging_bijwerken_doc', 'jsonb_object_agg', 'de opgeslagen ziekenhuizen één keer op id'),
  ('geinstalleerd',   'getal',          'kamers als tekst tellen zoals in de app'),
  ('getal',           'jsonb_typeof',   'bestaat die functie überhaupt'),
  ('soorten',         'cancellation',   'de soorten contactmoment aan de databankkant'),
  ('na_moment',       'voor_verkoop',   'bestaat die functie überhaupt'),
  ('geinstalleerd',   'per_ingreep',    'stuks van een product per ingreep zijn geen kamers'),
  ('per_ingreep',     'Stents',         'de producten per ingreep aan de databankkant'),
  ('voor_verkoop',    'purchasing',     'de fases vóór de verkoop aan de databankkant'),
  ('opvolging_aanvullen', 'kent_fase',  'een fase die het product niet kent schuift naar evaluatie'),
  -- Issue 22: elk record draagt zijn producten in een lijst. Draait er een
  -- oude zonder_aantal, dan haalt die het aantal van élk moment af (elk
  -- moment is nu een lijst). Draait er een oude read_state, dan krijgt de
  -- nieuwe app het oude document onomgezet, en de vlag shared nooit.
  ('products_of',     'followup.obj(e) -> ''products''', 'enkel de lijst: het oude "product" is al omgezet'),
  ('een_lijst',       'jsonb_build_array', 'bestaat die functie überhaupt'),
  ('lijstvorm_record', 'shared',        'de vlag van read_state() gaat eraf bij het schrijven'),
  ('lijstvorm_record', 'zonder_aantal', 'een moment over meer producten verliest zijn aantal, ook onbeperkt'),
  ('lijstvorm_hospital', 'lijstvorm_record', 'bestaat die functie überhaupt'),
  ('lijstvorm',       'lijstvorm_hospital', 'bestaat die functie überhaupt'),
  ('zonder_aantal',   'count(distinct x)', 'telt de volledige lijst, niet de vorm'),
  ('scope_entries',   'shared',         'een gesnoeid moment zegt de browser dat het gedeeld is'),
  ('scope_hospital',  'allowed, true)', 'de vlag shared enkel op momenten, niet op contactpersonen'),
  ('merge_entries',   'zonder_aantal_beperkt', 'geen aantal op een moment met het product van een collega'),
  ('merge_entries',   'then s.e else p.e', 'wie zich van een gedeeld moment afhaalt, verandert er verder niets aan'),
  ('merge_entries',   'only_in(followup.products_of(x.e), allowed)', 'een gedeeld plan afvinken zonder een eigen product wordt geweigerd'),
  ('een_lijst',       'product_sort',   'een lijst producten komt er altijd op één manier uit: uniek, niet leeg, gesorteerd'),
  ('product_sort',    'collate "C"',    'onbekende producten in een vaste volgorde, los van de taal van de server'),
  ('zonder_aantal_beperkt', 'only_in',  'bestaat die functie überhaupt'),
  -- Uit de veiligheidscontrole van 2026-11-15.
  ('zonder_aantal_beperkt', 'tellende_soorten', 'een moment met het product van een collega wordt geen tellende soort'),
  ('tellende_soorten', 'procedure',     'bestaat die functie überhaupt'),
  ('afgevinkt',       'incoming -> ''planned''', 'afvinken enkel als het plan ook echt weg is'),
  ('plan_bezet',      'planned',        'bestaat die functie überhaupt'),
  ('write_state',     'plan_bezet',     'een nieuw contactmoment op het id van een plan dat blijft, wordt geweigerd'),
  ('write_state',     'mode is null',   'een oproep zonder modus wordt geweigerd, niet stil als opslag behandeld'),
  ('aantal_eraf',     'family',         'bestaat die functie überhaupt'),
  ('read_state',      'lijstvorm',      'een oud document wordt bij het lezen omgezet'),
  ('write_state',     'lijstvorm(payload)', 'wat binnenkomt wordt omgezet en verliest shared, in elke modus'),
  ('write_state',     'lijstvorm(v_stored)', 'het opgeslagen document wordt omgezet vóór het vergelijken'),
  ('write_state',     'stamp_doc(v_basis', 'de stempel vergelijkt met het omgezette document'),
  ('feed_events',     'lijstvorm',      'een abonnement leest een oud document in de lijstvorm')
)
select v.functie,
       v.waarvoor,
       case when p.oid is null                                    then '>>> ONTBREEKT'
            when p.prosrc like '%' || v.moet_bevatten || '%'      then 'nieuw'
            else                                                       '>>> OUD' end as versie
  from verwacht v
  left join pg_proc p
    on p.proname = v.functie
   and p.pronamespace in ('followup'::regnamespace, 'public'::regnamespace)
 order by v.functie, v.moet_bevatten;

-- Alles "nieuw"? Dan draait de databank deze schema.sql en kan controle.sql
-- erover. Staat er ergens ONTBREEKT of OUD, voer dan eerst schema.sql opnieuw
-- uit — van schijf — en kijk hier opnieuw. Meldt de editor daarbij een fout in
-- plaats van succes, dan is er niets toegepast: de hele uitvoering zit in één
-- transactie. Die fout is dan het echte probleem, niet de versie.
