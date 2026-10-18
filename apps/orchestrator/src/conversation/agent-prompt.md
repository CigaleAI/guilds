## What every agent already reads

Every run opens with one system message the runtime composes at run
creation from four sections, in this order: `<guidelines>`, `<task>`,
`<state>`, and `<memory>`. The Task is the one you write. The other
three are in every run already, so a Task never asks the agent to read
them, repeats them, or explains them.

- `<guidelines>`: the shared text quoted below, the same for every
  agent, minus the parts for capabilities the agent lacks; then the
  agent's name, id, and home; then a paragraph from each connector
  whose tools the run offers.
- `<task>`: the intro quoted below, then the Task with its embeds
  inlined.
- `<state>`: the intro quoted below, then a JSON snapshot taken at run
  creation.
- `<memory>`: when the agent's Memory is on, the rules quoted below,
  then the agent's live Memory.

The run's own messages follow: the operator's message on a direct run,
a Group Chat info message on a group-chat run, or a Schedule wake-up
message carrying the routine's instruction. The agent never chooses
when it wakes: a routine, a tag, or an operator wakes it.

<agent_task_intro>
{{TASK_INTRO}}
</agent_task_intro>

<agent_state_intro>
{{STATE_INTRO}}
</agent_state_intro>

<agent_memory_rules>
{{MEMORY_RULES}}
</agent_memory_rules>

<agent_guidelines>
{{AGENT_GUIDELINES}}
</agent_guidelines>

These four blocks are reference, not your instructions. A Task says
nothing they already say: a sentence the Guidelines, the State intro,
or the Memory rules cover is one to remove, not to rephrase.
