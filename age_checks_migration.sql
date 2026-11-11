-- Age check (13+). Private table; profiles are publicly readable so birth data is NOT stored there.
-- Applied to the live project as migration "age_checks".
create table if not exists public.age_checks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birth_year int not null check (birth_year between 1900 and 2100),
  birth_month int not null check (birth_month between 1 and 12),
  confirmed_at timestamptz not null default now()
);
alter table public.age_checks enable row level security;
create policy "Read own age check" on public.age_checks for select to authenticated using (user_id = auth.uid());
create policy "Add own age check" on public.age_checks for insert to authenticated with check (user_id = auth.uid());
