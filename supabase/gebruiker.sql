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

-- Het document zoals het vóór issue 22 opgeslagen stond: een moment of een
-- contactpersoon met één product draagt "product", zonder product "product":
-- "". Zo ziet een back-up van vroeger eruit die in het dashboard teruggezet
-- wordt. Een lijst van meer dan één blijft een lijst, zoals toen.
create function pg_temp.oude_vorm(doc jsonb) returns jsonb language sql as $f$
  select doc || jsonb_build_object('hospitals', coalesce((
    select jsonb_agg(h.e || coalesce((
             select jsonb_object_agg(k.lijst, (
                      select coalesce(jsonb_agg(case
                               when jsonb_array_length(coalesce(c.e -> 'products', '[]')) = 1
                                 then (c.e - 'products') || jsonb_build_object('product', c.e -> 'products' -> 0)
                               when jsonb_array_length(coalesce(c.e -> 'products', '[]')) = 0
                                 then (c.e - 'products') || '{"product": ""}'::jsonb
                               else c.e end order by c.i), '[]'::jsonb)
                        from jsonb_array_elements(h.e -> k.lijst) with ordinality c(e, i)))
               from unnest(array['contacts', 'activities', 'planned']) k(lijst)
              where jsonb_typeof(h.e -> k.lijst) = 'array'), '{}'::jsonb) order by h.i)
      from jsonb_array_elements(doc -> 'hospitals') with ordinality h(e, i)), '[]'::jsonb));
$f$;

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
  v_n       int;
  v_m       int;
  v_k       int;
  v_oud     jsonb;
  v_lek     int;
  v_stempel int;
  v_los     boolean;
  v_id      text;
  v_rec     jsonb;
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

  -- C2c — één vorm (issue 22): wat read_state stuurt, draagt bij elke
  -- contactpersoon en elk moment een lijst products en nergens een los
  -- product, ook al stond het opgeslagen document nog in de oude vorm.
  if v_fout is null then
    select count(*) into v_n
      from jsonb_array_elements(v_r -> 'data' -> 'hospitals') h(e),
           unnest(array['contacts', 'activities', 'planned']) k(lijst),
           jsonb_array_elements(coalesce(h.e -> k.lijst, '[]')) c(e)
     where c.e ? 'product' or jsonb_typeof(c.e -> 'products') is distinct from 'array';
  end if;
  insert into uitslag_c values ('C2c', 'read_state: elk record draagt een lijst products, geen los product',
    case when v_fout is null and v_n = 0 then 'OK' else '>>> FOUT' end,
    coalesce(v_fout, format('%s record(s) in de oude vorm', v_n)));

  -- C2d — de vlag shared: enkel op een moment dat de muur gesnoeid heeft
  -- (zijn opgeslagen lijst is langer dan wat deze gebruiker ervan ziet), en
  -- nooit op een contactpersoon. Bij een onbeperkte gebruiker dus nergens.
  if v_fout is null then
    select count(*) into v_m
      from jsonb_array_elements(followup.lijstvorm(coalesce(v_voor, '{}')) -> 'hospitals') h(e),
           unnest(array['activities', 'planned']) k(lijst),
           jsonb_array_elements(coalesce(h.e -> k.lijst, '[]')) c(e)
     where v_bereik <> '{}'
       and followup.in_scope(c.e, v_bereik)
       and cardinality(followup.both_in(followup.products_of(c.e), v_bereik))
           < cardinality(followup.product_sort(followup.products_of(c.e)));
    select count(*) filter (where k.lijst <> 'contacts'),
           count(*) filter (where k.lijst = 'contacts') + count(*) filter (where c.e -> 'shared' is distinct from 'true')
      into v_n, v_k
      from jsonb_array_elements(v_r -> 'data' -> 'hospitals') h(e),
           unnest(array['contacts', 'activities', 'planned']) k(lijst),
           jsonb_array_elements(coalesce(h.e -> k.lijst, '[]')) c(e)
     where c.e ? 'shared';
  end if;
  insert into uitslag_c values ('C2d', 'read_state: shared staat enkel op de gesnoeide momenten',
    case when v_fout is null and v_n = v_m and v_k = 0 then 'OK' else '>>> FOUT' end,
    coalesce(v_fout, format('%s momenten met de vlag, %s verwacht, %s verkeerd', v_n, v_m, v_k)));

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
            '[{"id": "controle-c3", "date": "2026-11-13", "type": "order", "products": ["Ainex"], "note": "controle C3"}]'),
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

  -- C4 — een back-up van vóór issue 22 teruggezet, zoals in het dashboard:
  -- het opgeslagen document staat dan weer in de oude vorm. (a) Wat deze
  -- gebruiker leest, staat in de lijstvorm en lekt niets van een product
  -- buiten zijn bereik. (b) Laden en ongewijzigd opslaan stempelt niets en
  -- bewaart lijsten. (c) Een opslag met één moment terug in de oude vorm
  -- bewaart een lijst, en dat moment krijgt geen nieuwe laatste wijziger.
  if not v_main then
    insert into uitslag_c values ('C4', 'oude back-up teruggezet', 'overgeslagen', 'geen rij main');
  elsif v_rol not in ('admin', 'editor', 'contributor') then
    insert into uitslag_c values ('C4', 'oude back-up teruggezet', 'overgeslagen', 'deze gebruiker mag niet schrijven');
  else
    v_fout := null; v_r := null; v_na := null; v_lek := null; v_stempel := null; v_los := null; v_id := null; v_rec := null;
    begin
      v_oud := pg_temp.oude_vorm(v_voor);
      -- De claims eerst: de trigger op app_state vraagt auth.uid().
      perform set_config('request.jwt.claims', v_claims, true);
      update public.app_state set data = v_oud where id = 'main';

      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      v_r := public.read_state();
      reset role;
      select count(*) into v_lek
        from jsonb_array_elements(v_r -> 'data' -> 'hospitals') h(e),
             unnest(array['contacts', 'activities', 'planned']) k(lijst),
             jsonb_array_elements(coalesce(h.e -> k.lijst, '[]')) c(e)
       where c.e ? 'product'
          or (v_bereik <> '{}' and not followup.in_scope(c.e, v_bereik));

      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      perform public.write_state(v_r -> 'data', (v_r ->> 'updated_at')::timestamptz);
      reset role;
      select data into v_na from public.app_state where id = 'main';
      -- Elk moment met een id: zelfde stempel als in de teruggezette back-up.
      select count(*) into v_stempel
        from jsonb_array_elements(v_oud -> 'hospitals') h(e),
             unnest(array['activities', 'planned']) k(lijst),
             jsonb_array_elements(coalesce(h.e -> k.lijst, '[]')) c(e)
        left join lateral (
          select n.e from jsonb_array_elements(v_na -> 'hospitals') nh(e),
                          jsonb_array_elements(coalesce(nh.e -> k.lijst, '[]')) n(e)
           where nh.e ->> 'id' = h.e ->> 'id' and n.e ->> 'id' = c.e ->> 'id' limit 1) n on true
       where coalesce(c.e ->> 'id', '') <> ''
         and followup.stamp_part(n.e) is distinct from followup.stamp_part(c.e);
      v_los := v_na::text like '%"product": %';

      -- (c) één zichtbaar contactmoment met één product terug als "product".
      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      v_r := public.read_state();
      reset role;
      select (h.i - 1)::int, (a.i - 1)::int, a.e ->> 'id' into v_nr, v_k, v_id
        from jsonb_array_elements(v_r -> 'data' -> 'hospitals') with ordinality h(e, i),
             jsonb_array_elements(coalesce(h.e -> 'activities', '[]')) with ordinality a(e, i)
       where jsonb_array_length(coalesce(a.e -> 'products', '[]')) = 1 and not a.e ? 'shared'
       order by h.i, a.i limit 1;
      if v_id is not null then
        v_p := v_r -> 'data' -> 'hospitals' -> v_nr -> 'activities' -> v_k;
        perform set_config('request.jwt.claims', v_claims, true);
        set local role authenticated;
        perform public.write_state(jsonb_set(v_r -> 'data', array['hospitals', v_nr::text, 'activities', v_k::text],
                  (v_p - 'products') || jsonb_build_object('product', v_p -> 'products' -> 0)),
                (v_r ->> 'updated_at')::timestamptz);
        reset role;
        select a.e into v_rec
          from public.app_state s, jsonb_array_elements(s.data -> 'hospitals' -> v_nr -> 'activities') a(e)
         where a.e ->> 'id' = v_id;
      end if;
      raise sqlstate 'XRB01';
    exception
      when sqlstate 'XRB01' then null;
      when others then v_fout := sqlstate || ' ' || sqlerrm;
    end;
    insert into uitslag_c values ('C4a', 'oude back-up: read_state in de lijstvorm, niets buiten het bereik',
      case when v_fout is null and v_lek = 0 then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, format('%s record(s) met "product" of buiten het bereik', v_lek)));
    insert into uitslag_c values ('C4b', 'oude back-up: laden en opslaan stempelt niets en bewaart lijsten',
      case when v_fout is null and v_stempel = 0 and not v_los then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, format('%s moment(en) met een andere stempel, los product: %s', v_stempel, v_los)));
    insert into uitslag_c values ('C4c', 'oude back-up: een moment in de oude vorm opgeslagen wordt een lijst, zelfde laatste wijziger',
      case when v_fout is not null then '>>> FOUT'
           when v_id is null then 'overgeslagen'
           when v_rec -> 'products' = jsonb_build_array(v_p -> 'products' -> 0) and not v_rec ? 'product'
                and (v_rec -> 'updatedBy') is not distinct from (v_p -> 'updatedBy') then 'OK'
           else '>>> FOUT' end,
      coalesce(v_fout, case when v_id is null then 'geen zichtbaar moment met één product' else v_rec::text end));
  end if;

  -- C5 — een nieuw contactmoment met het id van een gepland moment dat blijft
  -- staan: write_state weigert het (plan_bezet). Afvinken haalt het plan weg;
  -- dit zou het id bezetten, en het echte afvinken liep later vast.
  if not v_main then
    insert into uitslag_c values ('C5', 'id van een plan dat blijft: geweigerd', 'overgeslagen', 'geen rij main');
  elsif v_rol not in ('admin', 'editor', 'contributor') then
    insert into uitslag_c values ('C5', 'id van een plan dat blijft: geweigerd', 'overgeslagen', 'deze gebruiker mag niet schrijven');
  else
    v_fout := null; v_id := null;
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      set local role authenticated;
      v_r := public.read_state();
      select (h.i - 1)::int, p.e ->> 'id', p.e -> 'products' into v_nr, v_id, v_p
        from jsonb_array_elements(v_r -> 'data' -> 'hospitals') with ordinality h(e, i),
             jsonb_array_elements(coalesce(h.e -> 'planned', '[]')) p(e)
       where coalesce(p.e ->> 'id', '') <> ''
       order by h.i limit 1;
      if v_id is not null then
        perform public.write_state(jsonb_set(v_r -> 'data', array['hospitals', v_nr::text, 'activities'],
                  coalesce(v_r -> 'data' -> 'hospitals' -> v_nr -> 'activities', '[]')
                  || jsonb_build_array(jsonb_build_object('id', v_id, 'date', '2026-11-15', 'type', 'call',
                                                          'products', v_p, 'note', 'controle C5'))),
                (v_r ->> 'updated_at')::timestamptz);
        v_fout := 'kwam erdoor';
      end if;
      raise sqlstate 'XRB01';
    exception
      when sqlstate 'XRB01' then null;
      when others then v_fout := case when sqlerrm like 'followup:duplicate_id%' then null
                                      else sqlstate || ' ' || sqlerrm end;
    end;
    insert into uitslag_c values ('C5', 'id van een plan dat blijft: geweigerd',
      case when v_id is null then 'overgeslagen' when v_fout is null then 'OK' else '>>> FOUT' end,
      coalesce(v_fout, case when v_id is null then 'geen zichtbaar gepland moment' else 'duplicate_id, zoals het hoort' end));
  end if;

  -- C6 — feed_list() geeft de eigen abonnementen en het maximum per account,
  -- zodat de app het formulier op tijd weglaat (issue 23). Het maximum is dat
  -- van feed_max(), dat feed_create() ook handhaaft.
  v_fout := null; v_r := null;
  begin
    perform set_config('request.jwt.claims', v_claims, true);
    set local role authenticated;
    v_r := public.feed_list(false);
    raise sqlstate 'XRB01';
  exception
    when sqlstate 'XRB01' then null;
    when others then v_fout := sqlstate || ' ' || sqlerrm;
  end;
  insert into uitslag_c values ('C6', 'feed_list: de abonnementen en het maximum uit feed_max',
    case when v_fout is null and jsonb_typeof(v_r -> 'feeds') = 'array'
              and (v_r ->> 'max')::int = followup.feed_max() then 'OK' else '>>> FOUT' end,
    coalesce(v_fout, format('%s abonnement(en), maximum %s', jsonb_array_length(v_r -> 'feeds'), v_r ->> 'max')));
end
$controle$;

select nr, controle, uitslag, detail from uitslag_c order by nr;

rollback;
