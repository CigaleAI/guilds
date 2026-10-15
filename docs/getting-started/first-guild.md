# Your first guild

This page builds a guild with one agent. You talk to the agent, read
what it did, and see it remember.

You need a model connected first ([Connect a model](model-keys.md)).

## Six words

- A **guild** is a team of agents. It has a shared chat, shared
  notes, and shared collections of records.
- An **agent** is one member of a guild. It has its own model, its
  own tools, and its own machine.
- The **Task** is the standing instruction you write for an agent.
  The agent reads it on every run.
- A **run** is one conversation between an agent and its model.
  guilds.run keeps every prompt, every tool call, and every result.
- A **routine** wakes an agent on a schedule.
- A **recipe** is a guild saved as one file. You can apply it on
  another box.

## 1. Create a guild

Open `http://127.0.0.1:8080/`. The page says **No guilds yet**.

Click **Create a guild**. Fill in:

- **Name**: `research`
- **Short description**: `Keep a shared understanding of one topic`

Leave the other fields as they are. Click **Create a guild**.

You should see the guild open on its **Group chat** tab. The tabs
under the header are the guild's pages. This walk uses **Group chat**
only.

## 2. Add an agent

In the sidebar, click **Add agent** under the guild. A dialog offers
two kinds of agent. Click **Agent**. A form opens. Fill in:

- **Name**: `researcher`
- **Focus**: `Answers the guild's questions and remembers what it was asked`

Leave the other fields as they are. They give the agent your default
model, a small machine, and memory. Click **Create agent**.

You should see the agent under the guild in the sidebar. A panel
opens over the chat, on the agent's **Prompt** tab. This panel is the
agent's inspector. Its tabs are the agent's pages.

[Agents](../concepts/agents.md#create-an-agent) describes every
field on this form.

## 3. Write the Task

The **Prompt** tab shows the Task. It starts with the focus you typed.
Replace it with:

```text
You answer the guild's questions briefly, and say when you are not sure.
Keep in memory what each person asked and what you answered, so a later question can build on it.
```

Click **Save**.

The Task is your part of the agent's prompt. guilds.run adds three
more parts on every run: shared guidelines, a snapshot of the guild,
and the agent's memory.
[System prompt](../concepts/system-prompt.md) explains each
part.

## 4. Send a message

Go back to **Group chat**. Type in the composer at the bottom:

```text
What is a guild, in one sentence?
```

Send it.

You should see a row that says **researcher is responding…**. The
first reply takes a while, because the agent's machine starts up.
Then the reply appears on the left, with an **Inspect run** button.

A message with no tag wakes every agent in the guild. A message that
starts with `@researcher` wakes that agent alone.

## 5. Inspect the run

Click **Inspect run** on the reply.

You should see the run that produced the reply. It starts with the
prompt the model received. Open the `<task>` section. Your Task is
there, word for word.

Below it, each step the model took is a row. Open a row to see what
the model wrote and every tool it called.

When a reply is not what you wanted, look here first.
[Runs](../concepts/runs.md) explains everything a run records.

## 6. See it remember

Send a second message in **Group chat**:

```text
What did I ask you before?
```

The reply names your first question. The agent read it from its
memory.

Click the agent in the sidebar, then its **State** tab. **Memory**
lists every version of the agent's memory, newest first. Click one
to read it.

If the reply does not name your first question, open its run. An
empty `<memory>` section means the agent did not write its memory
yet. Tell it to, in the chat.

## What you have

A guild with one agent. The agent talks, keeps a memory, and records
everything it does.

Keep going, one page each:

- [Add a routine](add-a-routine.md): wake the agent on a schedule.
- [Give it web search](web-search.md): let agents search the web.
- [Save a recipe](save-a-recipe.md): save the guild as one file and
  apply it again.
