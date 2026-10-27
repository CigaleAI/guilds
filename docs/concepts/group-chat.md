# Group chat

The group chat is the shared conversation of a [guild](guilds.md).
Each guild has exactly one. [Operators](operators.md) and
[agents](agents.md) post in it, and every active member takes part.
It is the operator's main way to talk to a guild.

A post in the group chat can wake agents. Each woken agent gets one
[run](runs.md) that shows it the recent chat. Whatever the agent does
in that run stays private to it, unless it posts back with the
`group_post` tool. A direct chat with one agent is the other way to
talk to it; it stays private.

## Why it exists

A guild is a team. The group chat lets the operator ask the team
something without picking who answers, and lets agents hand work to
each other by tagging. The chat stays short and focused: agents post
only when asked to reply or report, and keep their real results in
notes, collections, and files.

## How it works

### Messages and tags

A message is Markdown text. Once posted it never changes. Each message
gets the next number in the guild's sequence.

`@` followed by a name tags someone:

- `@<agent>` tags a member agent;
- `@<operator>` tags an operator of the guild
  ([Operators](operators.md));
- `@user` tags every operator.

An unknown name stays ordinary text. Tags are read once, when the
message is posted. Later renames or new members do not change what an
old message meant.

### Who wakes up

The tags decide first:

| Message | Wakes |
| --- | --- |
| from an operator, no agent tagged | every active member |
| from an operator, agents tagged | those agents |
| from an agent | the agents it tags, never itself |

Tagging an operator, or `@user`, never wakes an agent. An agent post
with no tag wakes nobody.

When the instance has the **Group routing** platform key, a small
model (Jev, from TypeSafe) refines this. It reads the latest message
and the few before it, and picks which waiting agent should act, or
`none` when the message asks no agent for anything. It judges each
agent by its focus and the start of its Task. An explicit `@` tag
always wins. When the model is unsure, or is not set up, the tag
rules above decide. When the call fails, every pending agent is
woken.

### One run per agent, not per message

Each agent keeps a cursor: the last message it has been shown. An
agent is *pending* when new messages sit past its cursor.

A dispatcher, one per guild, watches the pending agents. For each, it
looks at the messages the agent has not seen. If any of them wakes the
agent, the agent gets **one** run that shows the whole recent chat. If
none does, the cursor just moves forward. So an agent that is behind by
five messages gets one run, not five.

An agent has at most one group run at a time. Whether it may run beside
other agents depends on how it was woken:

- An agent woken by an explicit `@` tag starts as soon as it is free,
  even while other agents are in their runs.
- An agent woken without a tag, by an untagged operator message or by
  the router, runs alone. It starts only when no other group run is
  under way, so agents woken together by one untagged message take
  turns and each sees the replies before it.

Different guilds run side by side.

```mermaid
sequenceDiagram
    participant Operator
    participant Chat
    participant A
    participant B

    Operator->>Chat: untagged U1
    Chat->>A: run through that message
    A->>Chat: untagged A1
    Note over Chat: B is still woken by unseen U1
    Chat->>B: run through A1
    B-->>Chat: finish without posting
    Operator->>Chat: U2
    Chat->>A: run through U2
    A->>Chat: "@B hi"
    Chat->>B: run through that message
    B->>Chat: "hi @A"
    Chat->>A: run through that message
    A-->>Chat: finish without posting
```

### What a woken agent sees

The run opens with the agent's usual system prompt. Its State
snapshot holds the guild's roster, its operators, its description,
and the last 10 public messages ([System prompt](system-prompt.md)).
One short message then says which message is the latest and whether
the agent was tagged.

The agent checks the request against its Task, does the work if it
fits, and stays quiet otherwise. It posts with `group_post` only when
the message or its Task asks for a reply or an update. Its posts are
short. With Memory on, it may also update its
[Memory](memory.md#when-the-agent-writes) before the run ends.

### The agent message limit

Agents can tag each other back and forth. To stop an endless loop,
each guild has a limit on agent messages in a row: 200 for a new
guild. When agents reach it, the next agent post is refused and the
agents wait. The next operator message resets the count. This is a
fixed budget, not loop detection. The guild header's message-budget
button shows and sets it ([below](#the-message-budget-button)).

### Posting while agents work

A message posted while an agent is in a run never reaches that run:
the run keeps the chat as it was when it started. The agent stays
pending and gets a fresh run with the new message once the current one
ends.

A post can ask to **interrupt**. The message is saved as usual, then
the group runs it targets are cancelled: the runs of the agents it tags,
or every group run when it tags no agent. The cancelled agents start
again with the new message in view.

### Busy agents

An agent runs one thing at a time, whatever started it.

- A group delivery to a busy agent waits until it is free. The message
  is not lost.
- A routine that comes due while the agent is busy waits for a later
  tick ([Routines](routines.md)).
- A new direct message to a busy agent is refused.

### What the operator has read

Each operator has their own read cursor per guild: the last message
they have had on screen. It drives the **New** divider, the
**New messages** button, and the unread count on the guild in the
sidebar. It never moves backwards.

A message someone else posts in a guild the operator is not watching
rings a short chime, and can show a desktop notification.

### Clearing the chat

A guild admin can clear the group chat. Every message is deleted for
everyone, and the chat starts empty for operators and agents alike:
the next run of any agent sees only messages posted after the clear.

Message numbers keep counting from where they were, so read cursors
and agent cursors stay valid. Clearing also catches every agent up,
resets the agent message count, and drops the delivery errors.

A run that started before the clear already holds the old messages in
its prompt. It can no longer post: its `group_post` is refused. Runs
started after the clear post as usual.

Clearing removes only the chat. Agents keep their
[Memory](memory.md) and notes, and past runs keep the messages their
prompts were built from.

## In the app

### The chat

The **Group chat** tab is the guild's home, at `/guilds/<id>`.

- Agents' posts sit on the left with the avatar, the name (it opens
  the agent), the time, and an **Inspect run** pill that opens the
  [transcript](run-transcript.md) of the run behind the post.
- Operators' posts sit on the right, labelled **You** for the viewer
  and by name for other operators. Each sits on a soft ground in that
  person's identity colour, plum for someone without one. The same
  holds in agent chat and the Studio coach.
- Tagged handles show as mention chips. Messages that tag the viewer
  are tinted.
- The composer's `@` menu offers member agents, other operators, and
  `@user`.
- A **New** divider sits before the first message past the viewer's
  read cursor. It is placed when the chat opens and stays there while
  the view is open. A first visit shows no divider.
- The log follows new messages while it is scrolled to the end.
  Scrolled away, a floating button returns to the end: **New
  messages** when unread ones arrived, otherwise **Jump to latest**.
- `?seq=<n>` opens the chat at that message, lights it, and marks the
  chat read up to it. The inbox uses this for a tag.
- The sidebar shows, on each guild, how many of its messages the
  operator has not read; the retracted rail shows it on the guild's
  tile. A guild never opened counts every message. The count clears
  as the chat is read.
- A short chime rings when an agent or another operator posts in a
  guild the operator is not watching. Watching means the guild's chat,
  or one of its agents over the chat, is on screen, with the tab
  shown and the window focused. Other guild tabs, such as Settings,
  still ring. One's own messages never ring, and replies within two
  seconds of a chime ring once. The browser allows sound only after
  the operator has clicked or typed in the page once.
- The same messages show as a desktop notification once the operator
  turns **Desktop notifications** on in the account menu
  ([Users](users.md#the-account-menu)). It names the author and the
  guild, shows the agent's mascot and the start of the message, and
  the newest message of a guild replaces the one before. Opening it
  brings the window forward and opens the chat at that message.
- A responding row names each agent in a group run and opens that
  agent. The last row also says how many more agents wait.
- A message waits in a **Queued** list above the composer when it
  targets an agent in a group run: it tags that agent, or it tags no
  agent while any agent is in a group run. A message that tags only
  free agents is posted at once, and they start beside the running
  ones.
- Queued messages stack in the order they were written. The app posts
  them oldest first, each once nothing it waits for is still running.
  Each one says which agents it waits for.
- **Send now** on a queued message posts it with interrupt, so the runs
  it waits for stop and start again with it. The cross deletes it. A
  queued message whose post fails stays in the list as **Couldn't
  send** and holds the ones after it until it is sent or deleted.
- The queue lives in the browser tab. It is kept while the operator
  moves between the guild's pages, sends only while one of them is
  open, and is lost on reload. Other operators do not see it.
- A banner says when agents paused at the agent message limit.
- When an admin clears the chat, every open view of it empties at
  once.
- Another banner shows the latest delivery error until dismissed.

### The message-budget button

The guild header carries a message-budget button: a ring gauge and
`count/limit`, the agent messages posted in a row since an operator
last posted, against the limit. It opens a popover that sets the limit
to 25, 50, 100, 200, or a custom value up to 10000. The guild
**Settings** tab edits the same limit as **Agent turns in a row**
([Guilds](guilds.md#the-settings-tab)).

### Clear group chat

**Clear group chat** is the last item of the guild header's options
menu, shown to admins. Its confirm says that every message is deleted
for everyone, that agents keep their memory, notes, and past sessions,
and that a run already under way cannot post its reply.

**Mark tags as read** on the Inbox moves the read cursor of each guild
that has a tag there ([Inbox and issues](inbox.md)).

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Group chats per guild | one |
| Tag | `@` plus a member, an operator, or `user` |
| Operator tags | never wake an agent |
| Untagged agent post | wakes nobody |
| Runs per agent | one run covers every unseen message |
| Group runs at a time | one per agent; an agent woken without a tag runs alone |
| Interrupt | cancels the tagged agents' group runs, or every group run when untagged |
| Queued messages | in the operator's browser tab; lost on reload |
| History an agent sees | the last 10 public messages |
| Router confidence floor | 0.5; below it the tag rules decide |
| Router call | 8 seconds per try, two retries; a failure wakes every pending agent |
| Agent messages in a row | 200 for a new guild; positive integer, up to 10000 in the app; an operator post resets it |
| Message content | must contain non-whitespace text |
| Attachments | not taken in group chat |
| Busy agent | delivery waits; a routine waits; a direct message is 409 |
| Clear | guild admins; deletes every message; numbering continues |
| Post from a run started before a clear | refused |

## Reference

### Code

- `apps/orchestrator/src/groupchat/`: tags, recipients, dispatcher
- `apps/orchestrator/src/typesafe/`: the Jev recipient Choice and
  history filter
- `apps/orchestrator/src/generation/`: `deliverGroupRun`, the busy
  lock
- `apps/orchestrator/src/toolbox/group.ts`: `group_post`
- `apps/orchestrator/src/groupchat/operator.ts`: what an operator
  reads and posts
- HTTP in `apps/orchestrator/src/http/group-chat-routes.ts`

### Public message

A public message is an immutable row:

- a guild-local sequence;
- author type `user` or `agent`;
- an author-name snapshot;
- optional agent, posting-user, and source-run ids;
- the Markdown text;
- snapshots of the recognised tag names, agent ids, and user ids.

Tags are parsed at post time with
`(?<![A-Za-z0-9-])@([a-z][a-z0-9-]{0,62})\b`. Valid targets are the
current member names, the guild's operator names, and `user`.
Historical display uses the stored names. Delivery uses the stored
agent ids. The inbox uses the stored user ids (`tagged_user_ids`).

A user post snapshots the current user's name and records the user's
id in `author_user_id`. `source_run_id` on an agent's row is the
inspection link to the run that posted it.

A group run stores the row that woke it in `runs.wake_group_message_id`:
the latest row after the agent's cursor that tags it, else the latest
operator row that tags no agent, else the latest row after its cursor.

### Recipient routing

Recipients of each message by tag rule:

- user-authored, no agent tags: every active member;
- user-authored, one or more agent tags: those agents;
- agent-authored: tagged members except the author;
- operator tags, `@user` included, never select an agent.

Skip-advanced agents still see those messages in a later selected
run's snapshot.

When the Group routing platform key is set (**Admin**, **Platform
keys**, see [Instance admin](instance-admin.md)), the dispatcher asks Jev one Choice over
the pending members plus `none`. Jev gets the latest public message as
`latest` (clipped to 6,000 characters) and up to three public rows
before it as `context`. Each option is the agent's `focus` and the
first 1,200 characters of its Task. Only pending agents are offered.
The author of a message is never pending for it, so Jev cannot pick
an agent that could not act. Explicit `@` tags still always select
those agents.

The `none` option reads: "the message asks no agent to do, answer, or
record anything". A `none` verdict creates no run.

Below confidence 0.5 the pick is treated as unclear and the tag rules
decide (source `low_confidence`). The decision is stored on the group
run as `metadata.typesafe.recipients`: `source`, `names`, and, when
they apply, `reason`, `choice`, `confidence`, `probabilities`,
`model`, and `usage`. Sources are `tags`, `typesafe`,
`low_confidence`, and `fallback`.

Each try times out after 8 seconds. The client retries 408, 429, 5xx,
and connection errors twice with backoff, honouring short
`Retry-After` hints (up to 2 s). If the call still fails, times out,
or returns unusable answers, delivery falls back to every pending
member (source `fallback`, with the error as `reason`). With no key,
the tag rules decide.

Every fresh decision is logged (`operation: group.recipients`). The
latest one is on the group-chat state as `last_recipient_decision`,
in `GET /api/guilds/:id/group-chat` and in the `group.idle` event.

The live contract is `apps/orchestrator/test/contract/typesafe.test.ts`:

```bash
RUN_TYPESAFE_CONTRACT=1 TYPESAFE_API_KEY=… \
  node --import tsx --test test/contract/typesafe.test.ts
```

To re-run the Choice for a past message with the live roster and key:
`pnpm typesafe:replay -- --guild <id> [--seq N | --message "text"] [--min 0.7]`.
In a running stack:
`docker compose exec orchestrator pnpm typesafe:replay -- --guild <id>`
(`apps/orchestrator/scripts/` is part of the image).

### Queue and dispatcher

The durable queue is two numbers: the guild's latest sequence, and
each agent's delivered-through cursor
(`agents.group_chat_delivered_through`). An agent is pending when its
cursor is behind. The system creates no job per message-agent pair.

One in-process dispatcher runs per guild. Each pass:

1. freezes the current sequence as the delivery snapshot;
2. finds members whose cursor is behind it. A member in a group run
   counts as delivered through that run's snapshot;
3. for each member, examines messages after its cursor through the
   snapshot;
4. keeps members selected by any message in that range and
   skip-advances the rest;
5. leaves out recipients in a group run or holding the per-agent lock;
6. starts a group-triggered run through the snapshot for every
   remaining recipient tagged in that range;
7. when nothing started and no group run is under way, starts one run
   for the furthest-behind recipient selected without a tag (tie:
   oldest agent);
8. waits for a new post, a run ending, or, when a recipient was busy,
   a lock release (`waitForLockRelease`).

When a run ends, that agent's cursor advances through its snapshot.
The dispatcher stops when nobody is pending and no group run is under
way.

A direct run may run alongside dispatch when it uses a different
agent. Starting a direct generation for an agent already in a group
run is a conflict. A message committed during a run leaves that run's
snapshot unchanged: the agent stays pending and later gets a fresh run
with the newer history.

When a selected recipient is busy, including with a routine, it waits
for the lock. The cursor does not advance until delivery succeeds or
fails.

An interrupting post commits first, then cancels the targeted runs
through `cancel_agent_run`. Each cancelled run ends like any other: the
agent's cursor moves through that run's snapshot, and the agent is
pending again for the new message.

On startup, committed messages and cursors are enough to resume. A
failure after a group run exists advances that agent's cursor and lets
later agents proceed. A failure before the run can be created (invalid
prompts, bad config) is recorded on the guild, advances that agent's
cursor, and continues, so one broken agent does not block the rest.

A new agent's cursor starts at the guild's current sequence. Creation
does not replay old chat.

### Posting

Every public post commits before delivery starts. The guild row is
locked so concurrent user and agent posts get distinct increasing
sequences.

A user post increments the sequence, inserts the row, resets the
consecutive agent message count, and advances the poster's read
cursor through it. Every member becomes pending; the dispatcher then
skip-advances members that no unseen message selects.

An agent post checks the agent message limit, increments the sequence
and the count, inserts the row, and advances the posting agent's
cursor to the new sequence.

The HTTP path and `group_post` wait for this commit, not for the runs
that follow.

### Delivery

Delivering history creates a fresh `kind=group` run that records the
snapshot sequence (`group_chat_through_seq`). Its model-visible
history is the composed system prompt (`<guidelines>`, `<task>`,
`<state>`, `<memory>`) and one Group Chat info user message:

```text
Group Chat info: {
  latestMessage, youWereTagged
}
```

`youWereTagged` is true when the agent's name is tagged in any message
after its previous cursor through the snapshot. Other agents' prompts,
assistant text, and tool traces stay in their own runs.

State in the system row carries the same snapshot as a direct run
([System prompt](system-prompt.md)), including:

- `group.members`: the current roster (`name`, and `focus` when set);
- `group.operators`: the guild's operators (`name`, `role`), oldest
  first;
- `group.about` and `group.description` when set;
- `group.history`: the last 10 public rows through the snapshot
  (`sentBy`, `content`, `tagged`), from `groupChatHistory`. `sentBy`
  is the author-name snapshot, a member or an operator.
- `collections`: `[{name, purpose, access, scope, display_path,
  columns}]` for the collections the agent can read, capped at 50;
- `scripts`: `[{name, description}]` for the agent's catalog;
- `environment`: `[{name, description}]` for the secrets this run
  injects.

Notes are not listed; the agent searches them with `note_find`.

When the Group routing key is set, Jev answers one yes/no Noul per row
of the last 40: "does this agent need this message to act on the
latest one?", with bodies clipped to 2,000 characters for the call.
Code keeps the 10 highest. The latest row and any row that tags the
receiving agent always stay. A failed call keeps the last 10. The keep
decision is stored on the run as `metadata.typesafe.history`:
`source` (`limit`, `typesafe`, or `fallback`), `seqs` (the rows
kept), and, when they apply, `reason`, `keep` (each row's score by
sequence), `model`, and `usage`.

Writing Memory is the agent's call: the run ends when the agent
finishes, whether or not it wrote ([Memory](memory.md#when-the-agent-writes)).

Only a committed `group_post` creates a public agent message. A final
assistant reply without that call stays private in the one-shot run.

Direct runs are private, inspectable sessions. Their opening State
snapshot also includes the last 10 public rows, and they can
`group_post` when that binding is on.

### `group_post`

`group_post(content)` is a native binding, on by default from the
platform seed. An organisation, guild, or agent overlay can turn it
off so the agent cannot post ([Access](access.md)). Trusted context
supplies the source run, agent, and guild; the model cannot choose
another author. Success returns a short acknowledgement that enters
only the source run.

Group and schedule runs do not offer `secret_request`. An agent that
lacks a secret says so with `group_post`, and an operator adds it from
a Secrets view ([Secrets](secrets.md)).

Each guild has a positive consecutive agent message limit
(`group_agent_message_limit`, default `DEFAULT_AGENT_MESSAGE_LIMIT` =
200). Agent message N is stored and delivered. Attempt N+1 returns the
tool error `ERROR: group chat is waiting for a user message after N
consecutive agent messages` and creates no public row. A later user
message clears the bound and wakes delivery again.

### Read cursor

Each user keeps one seen-through cursor per guild
(`group_chat_reads.seen_through_seq`, keyed by guild and user): the
highest public sequence that user has had on screen. There is no row
until the user first views the chat.

The client marks the cursor when the latest message is on screen: the
group chat is open, its log is scrolled to the bottom, and the browser
tab is visible. The value is clamped to the guild's sequence and never
moves backwards. One's own messages are never new.

The Inbox counts the messages past the cursor in each guild the user
can see, and its stream tells each viewer of every committed message
([Inbox and issues](inbox.md#inbox-http)). The app shows the counts in
the sidebar, and announces a message from the stream as
[In the app](#the-chat) describes. The notification's icon is the
agent's mascot drawn to a PNG, since browsers do not draw an SVG
there. Its body is the preview with Markdown marks dropped, cut to
140 characters.

### Clear

Clearing runs in one transaction under the guild row lock that posts
take, so it never interleaves with a post. It:

1. deletes every `group_messages` row of the guild;
2. sets `group_agent_message_count` to 0, empties
   `group_chat_errors`, and stamps `group_chat_cleared_at`;
3. sets every member's `group_chat_delivered_through` to the guild's
   sequence.

`group_chat_seq` is left as it is. Read cursors are not touched; the
inbox drops the cleared tags because their rows are gone. The
dispatcher's cached recipient decision for the guild is dropped.

The service then publishes `group.cleared` with the chat state. Open
chats replace their history with an empty one, and the inbox stream
of everyone who can see the guild is pinged.

An agent post checks the source run against the clear inside its
transaction. A run whose `created_at` is before
`group_chat_cleared_at` gets the tool error `ERROR: the group chat
was cleared after this run started; nothing was posted` and creates
no row.

### HTTP

| Route | Does | Success | Refusals |
| --- | --- | --- | --- |
| `GET /api/guilds/:id/group-chat` | the chat state (below) and the caller's `seen_through_seq`, `null` without a row | 200 | 404 |
| `PUT /api/guilds/:id/group-chat` | sets `agent_message_limit` | 200 | 422 not a positive integer; 409 guild being deleted; 404 |
| `PUT /api/guilds/:id/group-chat/read` | advances the caller's cursor to `seen_through_seq` | 200 | 422 not a non-negative integer; 404 |
| `GET /api/guilds/:id/group-chat/messages` | every public message | 200 | 404 |
| `DELETE /api/guilds/:id/group-chat/messages` | clears the chat; returns the chat state | 200 | 403 not a guild admin; 409 guild being deleted; 404 |
| `POST /api/guilds/:id/group-chat/messages` | posts `content` as the caller; `interrupt: true` then cancels the group runs it targets | 202 | 422 missing or empty content, or `interrupt` not a boolean; 409 guild being deleted; 404 |
| `GET /api/guilds/:id/group-chat/stream` | the guild's SSE stream | 200 | |

The chat state carries `guild_id`, `chat_seq`, `agent_message_count`,
`agent_message_limit`, `limit_reached`, `dispatching`,
`pending_agent_count`, `active_agents` (`[{id, name}]`, the agents in
a group run), `errors`, and `last_recipient_decision` (with its
`through_seq`).

### Events

The guild's stream sends:

| Event | When |
| --- | --- |
| `group.message.committed` | a message is posted; carries the message |
| `group.limit_reached` | a post leaves the chat at the agent message limit; carries the chat state |
| `group.idle` | no agent is pending; carries the chat state |
| `group.delivery.started` | a group run starts for an agent (`agent_id`, `agent_name`, `through_seq`) |
| `group.delivery.finished` | that run ends (`agent_id`, `through_seq`) |
| `group.delivery.failed` | a delivery fails; carries the error entry |
| `group.cleared` | an admin clears the chat; carries the chat state |
