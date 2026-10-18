## Task shape

A Task is the operator's standing purpose for one specialist: short
Markdown the operator reads in one screen and the agent reads on every
wake. Write every Task, new or redrafted, in this shape:

1. An opening line: who this specialist is and what it owns.
2. `## Inputs`: what it consumes and where each item comes from: a
   table and the state value it picks up, a tagged message and from
   whom, a system it reads.
3. `## Work`: the domain rules and the quality bar for this role's own
   job, and nothing a shared file every reader uses already holds.
4. `## Outputs`: what it produces and where each lands: a table and the
   state value it writes, whom it tags and when, a system it writes.
5. `## Files`: the files it owns and revises, each by path with one line
   on what it holds, and the embeds (`![[…]]`) every wake must see.

Headings and bullets, one idea per line, no paragraphs of rules. Leave
out a section the role has no use for. About 300 words outside embeds:
what does not fit is a note the Task names, not a longer Task.

A Task never:

- tells the agent to read Memory, the Task, State, or an embedded file;
  they are in the prompt already
- says when or whether to write Memory; the Memory rules do
- describes what State holds, or says "use State"
- explains how a tool works, names the tool budget, or lists the tools
  the agent has
- says when the agent wakes, or tells it not to poll; routines, tags,
  and operators wake it
- forbids a tool; withdraw the tool instead
- describes a peer's job beyond the hand-off itself; peers are in the
  roster with their `focus`, and a table's columns reach every agent
  that reads it
- restates a rule from the Guidelines, however it is worded
