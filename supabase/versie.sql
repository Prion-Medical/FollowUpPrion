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
  ('scope_hospital',  'scope_contacts', 'de productlijst van een contactpersoon afschermen'),
  ('scope_contacts',  'both_in',        'bestaat die functie überhaupt'),
  ('merge_entries',   'merge_products', 'het vinkje van de collega niet laten wegnemen'),
  ('merge_products',  'only_in',        'bestaat die functie überhaupt'),
  ('merge_hospital',  'merge_products', 'dezelfde formule voor het ziekenhuis'),
  ('merge_doc',       'merge_entries',  'een nieuw ziekenhuis gaat door dezelfde regels'),
  ('producten',       'EndoQ',          'de productenlijst aan de databankkant')
)
select v.functie,
       v.waarvoor,
       case when p.oid is null                                    then '>>> ONTBREEKT'
            when p.prosrc like '%' || v.moet_bevatten || '%'      then 'nieuw'
            else                                                       '>>> OUD' end as versie
  from verwacht v
  left join pg_proc p
    on p.proname = v.functie
   and p.pronamespace = 'followup'::regnamespace
 order by v.functie, v.moet_bevatten;

-- Alles "nieuw"? Dan draait de databank deze schema.sql en kan controle.sql
-- erover. Staat er ergens ONTBREEKT of OUD, voer dan eerst schema.sql opnieuw
-- uit — van schijf — en kijk hier opnieuw. Meldt de editor daarbij een fout in
-- plaats van succes, dan is er niets toegepast: de hele uitvoering zit in één
-- transactie. Die fout is dan het echte probleem, niet de versie.
