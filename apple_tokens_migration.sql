-- Apple token revoke: Apple requires apps that offer Sign in with Apple to revoke the person's Apple
-- authorization when they delete their account. That needs the Apple refresh token from sign-in, kept
-- somewhere only the server can read. The app saves it through the function below at sign-in; the
-- delete-account Edge Function reads it, revokes it with Apple, and the row is removed with the account.

create table if not exists public.apple_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);
alter table public.apple_tokens enable row level security;
-- No policies on purpose: nobody can read or write this table directly except the server (service role).
revoke all on public.apple_tokens from anon, authenticated;

create or replace function public.save_apple_refresh_token(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 2000 then raise exception 'invalid token'; end if;
  insert into public.apple_tokens (user_id, refresh_token) values (auth.uid(), p_token)
  on conflict (user_id) do update set refresh_token = excluded.refresh_token, updated_at = now();
end $$;
revoke all on function public.save_apple_refresh_token(text) from public, anon;
grant execute on function public.save_apple_refresh_token(text) to authenticated;
