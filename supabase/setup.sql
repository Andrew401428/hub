-- Hub sync table. Run once in Supabase > SQL editor.
-- Replace CHANGE-ME with a secret word of your own (letters/numbers), then enter the same
-- word in Hub > Settings > Sync on every device. Anyone without the word gets 401.

create table if not exists public.hub_docs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.hub_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists hub_touch on public.hub_docs;
create trigger hub_touch before insert or update on public.hub_docs
  for each row execute function public.hub_touch();

create index if not exists hub_docs_updated_at on public.hub_docs (updated_at);

alter table public.hub_docs enable row level security;
grant select, insert, update, delete on public.hub_docs to anon;

drop policy if exists hub_secret_all on public.hub_docs;
create policy hub_secret_all on public.hub_docs for all to anon
  using  (current_setting('request.headers', true)::json ->> 'x-hub-secret' = 'CHANGE-ME')
  with check (current_setting('request.headers', true)::json ->> 'x-hub-secret' = 'CHANGE-ME');
