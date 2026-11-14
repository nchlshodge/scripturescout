-- Hide the names of players under 18 on every public leaderboard. Enforced in the database, so a modified app can't
-- put a minor's real username on a leaderboard.
--   * A score row for a player under 18 (or with no age on file yet) always carries a stable alias like "Scout 7F3A".
--   * When the player answers the age question (or later changes their username) their rows are re-synced:
--     adults get their real username back, minors keep the alias.
--   * Guests (no account) are untouched. Uses is_minor() from minor_safety_migration.sql.
-- Known limits: the alias is cosmetic against someone calling the API directly (leaderboard rows carry user_id, and
-- profiles are publicly readable); and a player who turns 18 keeps the alias on old rows until they next play
-- (or sign in and the age is re-saved).

create or replace function public.minor_display_name(p_user uuid) returns text
language sql immutable as $$ select 'Scout ' || upper(substr(md5(p_user::text), 1, 4)); $$;

create or replace function public.mask_minor_leaderboard_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then return new; end if;
  if public.is_minor(new.user_id) then
    if tg_table_name = 'leaderboard_trivia' then
      new.player_name := public.minor_display_name(new.user_id);
      new.username := public.minor_display_name(new.user_id);
    else
      new.name := public.minor_display_name(new.user_id);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_mask_minor_name on public.leaderboard;
drop trigger if exists trg_mask_minor_name on public.leaderboard_daily;
drop trigger if exists trg_mask_minor_name on public.leaderboard_memory;
drop trigger if exists trg_mask_minor_name on public.leaderboard_mia;
drop trigger if exists trg_mask_minor_name on public.leaderboard_track;
drop trigger if exists trg_mask_minor_name on public.leaderboard_trivia;
create trigger trg_mask_minor_name before insert or update on public.leaderboard        for each row execute function public.mask_minor_leaderboard_name();
create trigger trg_mask_minor_name before insert or update on public.leaderboard_daily  for each row execute function public.mask_minor_leaderboard_name();
create trigger trg_mask_minor_name before insert or update on public.leaderboard_memory for each row execute function public.mask_minor_leaderboard_name();
create trigger trg_mask_minor_name before insert or update on public.leaderboard_mia    for each row execute function public.mask_minor_leaderboard_name();
create trigger trg_mask_minor_name before insert or update on public.leaderboard_track  for each row execute function public.mask_minor_leaderboard_name();
create trigger trg_mask_minor_name before insert or update on public.leaderboard_trivia for each row execute function public.mask_minor_leaderboard_name();

-- Re-applies the right name to all of one player's existing rows.
create or replace function public.resync_leaderboard_names(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare real_name text; shown text;
begin
  select username into real_name from public.profiles where id = p_user;
  shown := case when public.is_minor(p_user) then public.minor_display_name(p_user) else real_name end;
  if shown is null then return; end if;
  update public.leaderboard        set name = shown where user_id = p_user;
  update public.leaderboard_daily  set name = shown where user_id = p_user;
  update public.leaderboard_memory set name = shown where user_id = p_user;
  update public.leaderboard_mia    set name = shown where user_id = p_user;
  update public.leaderboard_track  set name = shown where user_id = p_user;
  update public.leaderboard_trivia set player_name = shown, username = shown where user_id = p_user;
end $$;
revoke all on function public.resync_leaderboard_names(uuid) from public, anon, authenticated;
revoke all on function public.mask_minor_leaderboard_name() from public, anon, authenticated;

create or replace function public.resync_names_after_age_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.resync_leaderboard_names(new.user_id); return new; end $$;
create or replace function public.resync_names_after_rename() returns trigger
language plpgsql security definer set search_path = public as $$
begin if new.username is distinct from old.username then perform public.resync_leaderboard_names(new.id); end if; return new; end $$;
revoke all on function public.resync_names_after_age_check() from public, anon, authenticated;
revoke all on function public.resync_names_after_rename() from public, anon, authenticated;

drop trigger if exists trg_resync_names_age on public.age_checks;
create trigger trg_resync_names_age after insert or update on public.age_checks
  for each row execute function public.resync_names_after_age_check();
drop trigger if exists trg_resync_names_rename on public.profiles;
create trigger trg_resync_names_rename after update of username on public.profiles
  for each row execute function public.resync_names_after_rename();

-- One-time: apply it to every existing score row.
select public.resync_leaderboard_names(p.id) from public.profiles p;
