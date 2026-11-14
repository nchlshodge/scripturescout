-- Extra limits for players aged 13-17 (enforced on the server, so a modified app can't skip them):
--   1. Direct chats involving a player under 18 are only allowed between accepted friends.
--   2. A player under 18 can only be added to a group chat by one of their friends, and a player under 18
--      can only add their own friends.
--   3. Players under 18 don't appear in the friend search (they can still be added through their invite link).
--
-- "Under 18" comes from the private age_checks table, rounded toward caution (someone counts as an adult
-- once a full month has passed after their 18th birthday month). An account with NO age on file counts as
-- under 18 until it answers the age question, which the app asks at the next sign-in.
-- The helper functions are internal only: nobody can call them from the app, so nobody can ask "is this
-- person a minor?".

create or replace function public.is_minor(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ((extract(year from now())::int * 12 + extract(month from now())::int) - (a.birth_year * 12 + a.birth_month)) < 18 * 12 + 1
       from public.age_checks a where a.user_id = p_user),
    true);
$$;

create or replace function public.are_friends(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friends f
    where f.status = 'accepted'
      and ((f.user_id = p_a and f.friend_id = p_b) or (f.user_id = p_b and f.friend_id = p_a)));
$$;
revoke all on function public.is_minor(uuid) from public, anon, authenticated;
revoke all on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- Adding someone to a conversation. (PT403 makes the API answer "403", which the app turns into a clear message.)
create or replace function public.enforce_minor_chat_members() returns trigger
language plpgsql security definer set search_path = public as $$
declare conv_type text; other uuid;
begin
  if auth.uid() is null then return new; end if;                    -- server-side work (e.g. account deletion)
  select type into conv_type from public.conversations where id = new.conversation_id;
  if conv_type = 'direct' then
    for other in select user_id from public.conversation_members where conversation_id = new.conversation_id and user_id <> new.user_id loop
      if (public.is_minor(new.user_id) or public.is_minor(other)) and not public.are_friends(new.user_id, other) then
        raise exception 'Chats with players under 18 are limited to friends.' using errcode = 'PT403';
      end if;
    end loop;
  end if;
  if new.user_id <> auth.uid()
     and (public.is_minor(new.user_id) or public.is_minor(auth.uid()))
     and not public.are_friends(new.user_id, auth.uid()) then
    raise exception 'Players under 18 can only be added to chats by their friends.' using errcode = 'PT403';
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_minor_chat_members on public.conversation_members;
create trigger trg_enforce_minor_chat_members
  before insert on public.conversation_members
  for each row execute function public.enforce_minor_chat_members();

-- Sending a message in a direct chat (covers chats that were set up before this rule existed).
create or replace function public.enforce_minor_chat_messages() returns trigger
language plpgsql security definer set search_path = public as $$
declare conv_type text; other uuid;
begin
  if auth.uid() is null then return new; end if;
  select type into conv_type from public.conversations where id = new.conversation_id;
  if conv_type = 'direct' then
    for other in select user_id from public.conversation_members where conversation_id = new.conversation_id and user_id <> new.sender_id loop
      if (public.is_minor(new.sender_id) or public.is_minor(other)) and not public.are_friends(new.sender_id, other) then
        raise exception 'Chats with players under 18 are limited to friends.' using errcode = 'PT403';
      end if;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_minor_chat_messages on public.messages;
create trigger trg_enforce_minor_chat_messages
  before insert on public.messages
  for each row execute function public.enforce_minor_chat_messages();

-- Friend search that leaves out players under 18 (and the person searching).
create or replace function public.search_players(p_query text) returns table (id uuid, username text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username
  from public.profiles p
  where auth.uid() is not null
    and char_length(trim(p_query)) >= 2
    and p.id <> auth.uid()
    and p.username ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and not public.is_minor(p.id)
  order by p.username
  limit 5;
$$;
revoke all on function public.search_players(text) from public, anon;
grant execute on function public.search_players(text) to authenticated;
