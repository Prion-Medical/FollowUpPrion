-- ===========================================================================
--  FollowUp — controle als een echte gebruiker (vroeger deel C van controle.sql)
-- ===========================================================================
-- Dezelfde controles als toen, maar in één keer: elke controle draait in een
-- eigen subtransactie die altijd teruggedraaid wordt, dus een controle die
-- hoort te mislukken zet de rest niet stil, en er blijft niets van over. Het
-- antwoord is één tabel met OK of >>> FOUT per regel, zoals deel A.
--
-- Vul hieronder één keer het uuid in, of laat de terminal het doen:
--   sed 's/PLAK-HIER-HET-UUID/<uuid>/' supabase/gebruiker.sql | pbcopy
-- Neem een aanvuller die enkel Ainex mag (zo staat hij op de ontwikkeldatabank):
-- C1 en C2 werken met elke gebruiker, C3 zegt pas iets met die ene.
--   select u.id, u.email, a.role, a.products
--     from auth.users u join public.app_users a on a.id = u.id;
--
-- C2b en C3 hebben een rij 'main' nodig; zonder zeggen ze "overgeslagen".

begin;

create temp table uitslag_c (nr text, controle text, uitslag text, detail text) on commit drop;

do $controle$
declare
  c_wie     constant text := 'PLAK-HIER-HET-UUID';
  v_claims  text;
  v_rol     text;
  v_bereik  text[];
  v_main    boolean;
  v_totaal  int;
  v_voor    jsonb;
  v_r       jsonb;
  v_na      jsonb;
  v_door    text;
  v_fout    text;
  v_nr      int;
  v_p       jsonb;
  v_sql     text;
  v_letter  text;
  i         int := 0;
begin
  begin
    perform c_wie::uuid;
  exception when others then
    raise exception 'Vul bovenaan het uuid in (nu staat er: %)', c_wie;
  end;
  v_claims := jsonb_build_object('sub', c_wie, 'role', 'authenticated')::text;

  select a.role, a.products into v_rol, v_bereik from public.app_users a where a.id = c_wie::uuid;
  if v_rol is null then
    raise exception 'Geen rij in app_users voor %', c_wie;
  end if;
  select data into v_voor from public.app_state where id = 'main';
  v_main   := v_voor is not null;
  v_totaal := coalesce(jsonb_array_length(v_voor -> 'hospitals'), 0);

  insert into uitslag_c values ('C0', 'de nagedane gebruiker', 'info',
    format('rol %s, bereik %s, %s ziekenhuizen opgeslagen', v_rol,
           case when v_bereik = '{}' then 'onbeperkt' else array_to_string(v_bereik, ', ') end, v_totaal));

  -- C1 — de muur: alle drie moeten mislukken met "permission denied".
  foreach v_sql in array array['select count(*) from public.app_state',
                               'select count(*) from public.app_state_backups',
                               'select followup.my_role()'] loop
    i := i + 1;
    v_letter := chr(96 + i);
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      execute v_sql;
      v_fout := 'kwam erdoor';
      raise sqlstate 'XRB01';
    exception
      when sqlstate 'XRB01' then null;
      when insufficient_privilege then v_fout := null;
      when others then v_fout := sqlstate || ' ' || sqlerrm;
    end;
    insert into uitslag_c values ('C1' || v_letter, 'de muur: ' || v_sql || ' wordt geweigerd',
      case when v_fout is null then 'OK' else '>>> FOUT' end, coalesce(v_fout, 'permission denied'));
  end loop;

  -- C2a — wat deze gebruiker te zien krijgt: zijn rol, zijn bereik, en elk
  -- ziekenhuis (de muur staat rond de gegevens, niet rond het ziekenhuis).
  v_fout := null;
  begin
    perform set_config('request.jwt.claims', v_claims, true);
    set local role authenticated;
    v_r := public.read_state();
    raise sqlstate 'XRB01';
  exception
    when sqlstate 'XRB01' then null;
    when others then v_fout := sqlstate || ' ' || sqlerrm;
  end;
  insert into uitslag_c values ('C2a', 'read_state: rol en bereik zijn die uit app_users',
    case when v_fout is null and v_r ->> 'role' = v_rol and v_r -> 'products' = to_jsonb(v_bereik)
         then 'OK' else '>>> FOUT' end,
    coalesce(v_fout, format('rol %s, bereik %s', v_r ->> 'role', v_r -> 'products')));
  insert into uitslag_c values ('C2a', 'read_state: elk ziekenhuis blijft zichtbaar',
    case when v_fout is null and coalesce(jsonb_array_length(v_r -> 'data' -> 'hospitals'), 0) = v_totaal
         then 'OK' else '>>> FOUT' end,
    coalesce(v_fout, format('%s van %s', jsonb_array_length(v_r -> 'data' -> 'hospitals'), v_totaal)));

  -- C2b — laden en ongewijzigd terugsturen: het document mag geen byte anders
  -- worden, en updated_by is de nagedane gebruiker (de databank stempelt).
  if not v_main then
    insert into uitslag_c values ('C2b', 'rondgang: laden en opslaan verandert niets', 'overgeslagen', 'geen rij main');
  else
    v_fout := null; v_na := null; v_door := null;
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      v_r := public.read_state();
      perform public.write_state(v_r -> 'data', (v_r ->> 'updated_at')::timestamptz);
      reset role;
      select data, updated_by::text into v_na, v_door from public.app_state where id = 'main';
      raise sqlstate 'XRB01';
    exception
      when sqlstate 'XRB01' then null;
      when others then v_fout := sqlstate || ' ' || sqlerrm;
    end;
    insert into uitslag_c values ('C2b', 'rondgang: laden en opslaan verandert niets',
      case when v_fout is null and md5(v_na::text) = md5(v_voor::text) then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, case when md5(v_na::text) = md5(v_voor::text) then 'geen byte anders'
                            else 'het document veranderde' end));
    insert into uitslag_c values ('C2b', 'rondgang: updated_by is de nagedane gebruiker',
      case when v_fout is null and v_door = c_wie then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, v_door));
  end if;

  -- C3 — wat een contactmoment met de opvolging doet, langs de echte
  -- write_state(). In het eerste ziekenhuis waar EndoQ aangevinkt staat komt
  -- een Ainex-bestelling bij (en het Ainex-vinkje), zoals de koppeling dat
  -- doet: het moment erbij, de opvolging niet verzet. De databank hoort de
  -- Ainex-rij groen te maken en de EndoQ-rij te laten zoals ze stond. Staat
  -- EndoQ nergens aangevinkt, dan neemt het het eerste ziekenhuis en zegt de
  -- tweede regel weinig.
  if not v_main then
    insert into uitslag_c values ('C3a', 'opvolging: een Ainex-bestelling maakt de Ainex-rij groen', 'overgeslagen', 'geen rij main');
  elsif not (v_bereik = '{}' or 'Ainex' = any(v_bereik)) or v_rol not in ('admin', 'editor', 'contributor') then
    insert into uitslag_c values ('C3a', 'opvolging: een Ainex-bestelling maakt de Ainex-rij groen', 'overgeslagen',
      'deze gebruiker mag geen Ainex schrijven; neem de aanvuller die enkel Ainex mag');
  else
    select coalesce((select (t.i - 1)::int
                       from jsonb_array_elements(v_voor -> 'hospitals') with ordinality t(e, i)
                      where t.e -> 'products' ? 'EndoQ' order by t.i limit 1), 0)
      into v_nr;
    v_fout := null; v_na := null;
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      v_r := public.read_state();
      v_p := v_r -> 'data' -> 'hospitals' -> v_nr -> 'products';
      perform public.write_state(
        jsonb_set(jsonb_set(v_r -> 'data',
          array['hospitals', v_nr::text, 'products'],
          case when v_p ? 'Ainex' then v_p else coalesce(v_p, '[]') || '["Ainex"]' end),
          array['hospitals', v_nr::text, 'activities'],
          coalesce(v_r -> 'data' -> 'hospitals' -> v_nr -> 'activities', '[]') ||
            '[{"id": "controle-c3", "date": "2026-11-13", "type": "order", "product": "Ainex", "note": "controle C3"}]'),
        (v_r ->> 'updated_at')::timestamptz);
      reset role;
      select data -> 'hospitals' -> v_nr into v_na from public.app_state where id = 'main';
      raise sqlstate 'XRB01';
    exception
      when sqlstate 'XRB01' then null;
      when others then v_fout := sqlstate || ' ' || sqlerrm;
    end;
    insert into uitslag_c values ('C3a', 'opvolging: een Ainex-bestelling maakt de Ainex-rij groen',
      case when v_fout is null and v_na #>> '{pipeline,Ainex,status}' = 'green' then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, format('%s: %s', v_na ->> 'name', v_na #> '{pipeline,Ainex}')));
    insert into uitslag_c values ('C3b', 'opvolging: de EndoQ-rij blijft zoals ze stond',
      case when v_fout is null
                and (v_na #> '{pipeline,EndoQ}') is not distinct from (v_voor -> 'hospitals' -> v_nr #> '{pipeline,EndoQ}')
           then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, coalesce((v_na #> '{pipeline,EndoQ}')::text, 'geen EndoQ-rij')));
  end if;
end
$controle$;

select nr, controle, uitslag, detail from uitslag_c order by nr;

rollback;
