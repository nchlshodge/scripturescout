-- Chat moderation: per-message reports + server-side block of objectionable text messages.

alter table public.user_reports
  add column if not exists message_id integer references public.messages(id) on delete set null,
  add column if not exists message_excerpt text check (message_excerpt is null or char_length(message_excerpt) <= 300);

-- Server-side backstop for the client-side filter (clients can be modified).
-- Word-boundary match after de-obfuscating common substitutions (@->a, 0->o, 1->i, 3->e, $->s, 5->s).
-- Only applies to typed text messages; shared verses/scores are exempt.
create or replace function public.reject_objectionable_message() returns trigger
language plpgsql as $$
declare t text;
begin
  if new.type is distinct from 'text' or new.content is null then return new; end if;
  t := lower(translate(new.content, '@013$5!', 'aoiessi'));
  if t ~ '\m(fuck\w*|shit\w*|bitch\w*|cunt|nigg\w*|fag+(ot)?s?|whore|slut|dick\s?head|asshole|bastard|retard\w*|rape|kill\s+yourself|kys)\M' then
    raise exception 'Message contains language that is not allowed' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_reject_objectionable_message on public.messages;
create trigger trg_reject_objectionable_message
  before insert on public.messages
  for each row execute function public.reject_objectionable_message();
