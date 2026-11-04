-- FollowUp Prion – databank in Supabase
-- Plak dit in Supabase → SQL Editor → New query → Run.

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

-- De Data API werkt met twee rollen: anon (niet aangemeld) en authenticated
-- (aangemeld). Een nieuw Supabase-project kan die rechten automatisch geven bij
-- elke nieuwe tabel ("Automatically expose new tables"), maar dat staat niet
-- overal aan. Daarom zetten we ze hier zelf, zodat dit script werkt ongeacht
-- die instelling. Geen delete: verwijderen hoort hier niet via de app te kunnen.
grant usage on schema public to authenticated;
grant select, insert, update on public.app_state to authenticated;
grant select on public.app_state_backups to authenticated;

-- Beveiliging: enkel aangemelde gebruikers mogen lezen en schrijven.
alter table public.app_state enable row level security;
alter table public.app_state_backups enable row level security;

drop policy if exists "aangemeld lezen" on public.app_state;
drop policy if exists "aangemeld toevoegen" on public.app_state;
drop policy if exists "aangemeld wijzigen" on public.app_state;
drop policy if exists "aangemeld back-ups lezen" on public.app_state_backups;

create policy "aangemeld lezen" on public.app_state
  for select to authenticated using (true);
create policy "aangemeld toevoegen" on public.app_state
  for insert to authenticated with check (true);
create policy "aangemeld wijzigen" on public.app_state
  for update to authenticated using (true) with check (true);
create policy "aangemeld back-ups lezen" on public.app_state_backups
  for select to authenticated using (true);

revoke all on public.app_state, public.app_state_backups from anon;
