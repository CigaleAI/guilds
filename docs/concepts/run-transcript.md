# Run transcript

The run transcript is how the operator reads a [run](runs.md) in the
agent's **Chat** tab. It shows the prompt the run started from, the
tools it was offered, and every step the agent took, in order. Each
step shows the model's reasoning, the tools it called, and what each
call returned.

The transcript renders the run's stored rows, so it shows exactly
what the agent saw and did. Usage figures on it come from the same
rows ([Usage](usage.md)).

## When you use it

- You check why an agent did something: the prompt it saw, the
  reasoning, and the results it acted on.
- You look for what failed: a tool error, a cap, a provider error.
- You follow a long run while it works, step by step.
- You answer an agent that asked for a secret.

## How it works

### Three tabs

The transcript has three tabs:

- **Conversation**, open first: the messages and run flows.
- **System**: the composed system prompt, one card per section
  (`<guidelines>`, `<task>`, `<state>`, `<memory>`)
  ([System prompt](system-prompt.md)).
- **Tools**: the tools the run was offered, with their count on the
  tab.

A run without a system message has no System tab. A run without
offered tools has no Tools tab. In the System tab, each section shows
its tagged parts as nested cards: JSON as a folding tree, the rest as
Markdown. Each section and each part has a copy button. Note embeds
in the Task show as their inlined bodies, the nested hop included.

### Messages

- Operator messages and final replies are bubbles. A run woken by the
  group chat or a routine says so.
- A reply with reasoning shows it as a collapsed block above the text.
  While the agent generates, reasoning streams into that block. The
  block collapses when the reply starts.
- A reply cut by `finish_reason: length` says the output token limit
  was reached.
- While the agent generates and nothing has streamed yet, the
  transcript shows the agent's avatar, three pulsing dots, and
  **<name> is thinking…**. Once text streams, three pulsing dots sit
  under it until the generation ends.

### Run flows

Consecutive model steps that called tools render as one **run flow**
per generation. Its header shows:

- the title, which names the model on hover, and how the generation
  ended: **Done**, **Running…**, or its error count
- its time (model and tool time on hover), steps, tool calls, failed
  calls, tokens, and cost
- a toolbar

Below the header, the generation reads down a rail as one block per
model step. Each block sits on a dot. The dot is plum when a call
failed, pulses while a call runs, and shows the harness's logo for a
step that ran a code task. A step is reasoning, then calls, and
sometimes text the model wrote alongside them. The model's final reply
has no calls, so it is a bubble after the flow, not a step.

An error recorded for the generation shows as a red banner at the
bottom of its flow, with the message and the operation.

### Steps

A step's header names what its calls did, one short line per call,
such as **Read** and a path or **Run** and a command. Calls in a row
that open with the same verb share it: **Read a.md, b.md · Run ls**.
Cues follow:

- the kinds of the calls: read, write, execute, and so on
- a **wrote** or **ran script** tag
- an **N failed** tag when any call failed
- a wrench with the call count
- the step's time, with model and tool time on hover

Hovering the header adds the step's tokens and cost. A step cut by
`finish_reason: length` carries **max tokens**. Any finish reason
other than stopping or calling tools is tagged too.

Under the header sits the text the model wrote alongside the calls,
as muted lines. A folded step shows two lines of plain text and its
code tasks. An open step adds its name, **Step N**, and shows in
order:

- a **thinking** line for its reasoning, folded to its opening line;
  **more** unfolds a longer one, with a copy button
- the calls it requested. A single call is its card. Several calls
  from one model turn are a batch: their cards, numbered in the order
  they ran, held by one bracket. The calls of a batch run one after
  another, with no model turn between them.
- its code tasks

Two or more steps in a row with no text and no code task compact into
one block on a stack: **N steps**, with the same cues over all their
calls. Opening it shows them as step blocks on a rail of their own.

A block that holds a running call, or the call the view was opened
on, starts open.

### The toolbar

- **Writes** and **Errors** open the blocks that hold calls that
  changed tracked state, or failed calls, and dim everything else.
  Each carries its count, as does **All**, which keeps every call.
- **Expand all** opens every block and unfolds every reasoning line.
  **Collapse all** folds them back and returns to **All**.
- **Hide thinking** drops the reasoning from open steps.
- **Jump to answer** scrolls to the last text the model wrote in the
  flow.

Tracked state is a note, memory, record, collection, or script that a
call created, edited, or deleted, or source code changed through
`code_task`. Commands, script runs, posts, schedules, and browser
actions are not writes.

### Tool calls

Tool calls are coloured by kind: memory, read, write, execute, act,
post, connected. A call that is still running shows a spinner in
place of its result mark.

- A call that changed tracked state carries a **wrote** tag. A
  `script_run` call carries a **ran script** tag.
- A `note_write`, `memory_write`, or `script_create` call carries a
  chip naming the note, memory, or script it wrote. The chip opens it
  in the agent's State tab.
- A `shell` call reads **Run**, or **Start** for a background command,
  and the command's first line, then its exit code when it is not 0.
- A `file_read` call reads **Read** and the path. A repeated read
  names the step it points to.
- A `secret_store` call reads **Stored NAME**. A `secret_request` call
  reads **Asked for NAME**.

Opening a call expands its card onto its arguments and result. Each
shows as a folding JSON tree or raw text, with a copy button. Its
metadata follows: call id, duration, output filter, exit code, the
full-output log path, the working directory, the file and its lines,
the step a repeated read points to, stored bytes, and tool calls
left. The call's kind and level sit beside the views.

### Code tasks

A `code_task` call is its own block in its step. It shows even while
the step is folded. While it runs, its latest progress lines show
under its brief. Opening it shows its result, its metadata (status,
harness, repository, session, diffstat, and log path), and its
**Diff** ([Code tools](coding/code-tools.md#in-the-app)).

Progress lines are live only. They stream while the run view is open
and are not stored, so a reload shows the call without them until the
result lands.

A run with repository changes ends with a **Changes** panel: each
repository with its branch and diffstat, and **Show diff**, which
fetches the run's diff from the agent's machine
([Reviewing changes](coding/reviewing-changes.md)).

### Errors outside a flow

A run error that belongs to no run flow, such as a failure before the
first model reply, shows as a red banner at the top of the
Conversation tab. It is the latest such error, with its message and
operation ([Runs](runs.md#errors-and-logs)).

### Secret request cards

Each `secret_request` call whose result asked the operator renders a
card after its run flow. It shows the agent, the variable name, the
use, the reason, and "Written by the agent. The value reaches this
agent's commands, and other agents on the same machine can read it."

The card keeps no state. It looks the name up in the organisation and
in the agent's environment, so a card in any session shows the name's
current state:

- A name the organisation lacks gets the description, prefilled from
  the request, a password field, and **Provide**. **Provide** creates
  the secret, granted to this agent. An owner or admin may pick its
  guild or the organisation instead.
- A name that exists but does not reach the agent shows who has it.
  An owner or admin gets **Grant to this agent**. Other members read
  "An org owner or admin can grant it to this agent."
- A name in the agent's environment reads **NAME is set**.

After **Provide** or **Grant to this agent**, when the run is active
and not generating, the card sends the chat message
`Secret NAME is set.` That message starts a generation with the new
variable. The value never enters the transcript. The operator
declines by replying in the chat ([Secrets](secrets.md)).

## In the app

The transcript is the body of the agent's **Chat** tab
([Runs](runs.md#in-the-app)). `?run=<run id>` opens a run's
transcript, streaming while it generates. `&call=<tool call id>` or
`&seq=<n>` also opens that step, lit, and scrolls to it.

## Reference

### Live updates

The transcript renders committed rows. Reasoning, text deltas, and
`code_task` progress lines stream over the run's SSE stream before
their row lands ([Runs](runs.md#streaming)). On reconnect the view
reloads the ordered history, then consumes new events.

### Code

- `apps/web/src/features/agent/chat/Transcript.tsx`: the tabs, the
  bubbles, the typing indicator, and the error banner
- `apps/web/src/features/agent/chat/FlowView.tsx`: run flows, steps,
  and the toolbar
- `apps/web/src/features/agent/runs/runFlowModel.ts`: how rows and
  run errors group into flows
- `apps/web/src/features/agent/chat/SecretRequestCard.tsx`: the
  secret request card
- `packages/ui/src/components/runs/ToolCall.tsx`: the tool call card
- `packages/ui/src/components/conversation/TypingIndicator.tsx`: the
  typing dots
