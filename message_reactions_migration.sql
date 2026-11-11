-- Emoji reactions on chat messages (the client's toggleReaction()/openConversation()
-- already read and write this table; it was missing from the database, so reactions
-- never worked). Applied to the live project as migration "create_message_reactions".

create table if not exists public.message_reactions (
  id bigint generated always as identity primary key,
  message_id integer not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create index if not exists message_reactions_message_idx on public.message_reactions(message_id);

alter table public.message_reactions enable row level security;

-- Anyone in the conversation a message belongs to can see its reactions.
create policy "Members read reactions"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id
    where m.id = message_reactions.message_id and cm.user_id = auth.uid()
  ));

-- You can only react as yourself, and only inside a conversation you belong to.
create policy "Members add own reactions"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_reactions.message_id and cm.user_id = auth.uid()
    )
  );

-- Remove only your own reactions.
create policy "Users delete own reactions"
  on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());
