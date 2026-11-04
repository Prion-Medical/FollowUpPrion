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

-- Dagelijkse kopie van het document, zodat je altijd kan terugkeren.
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
  insert into public.app_state_backups (id, day, data, saved_at)
  values (new.id, current_date, new.data, now())
  on conflict (id, day) do update set data = excluded.data, saved_at = excluded.saved_at;
  return new;
end $$;

drop trigger if exists app_state_backup on public.app_state;
create trigger app_state_backup
  after insert or update on public.app_state
  for each row execute function public.backup_app_state();

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
