# Philosophy

Agent-to-agent collaboration opens uses of LLMs that a single agent
cannot cover. It also accentuates the ways those models fail: hidden
assumptions, loops that compound them, work that cannot be traced.

guilds.run is the framework Cigale AI built from years of running LLMs
so that collaboration stays tractable.

System thinking used to be work for people who already wrote
software. With LLMs it is available to anyone with a need or an
interest. The level of abstraction changed. The need to see and
steer the system did not.

The [index](README.md) is the short form of this page and the map
of the rest of the docs.

## Deeply inspectable

What the model sees is what you see.

Models make hidden assumptions. In a loop those assumptions stack.
The operator cannot design a long-running multi-agent workflow if
the guts stay hidden.

Every run keeps the prompt the model saw, every tool call, every
side effect, every error, and every memory change. Each of those
can be inspected and traced back.

## Deeply customizable

Each connection, each tool available to an agent, and the model
that agent uses is chosen for that job.

The same guild can mix open-weight and hosted models. A run needs
one key: the instance's or the organisation's.

## Iterate till perfection

A multi-agent system that survives long-running real use is hard
to get right on the first pass. The product is built for iterative
refinement: change a prompt, a tool, a routine, and watch the next
run.

## Share the love

Not everyone wants to spend time on system thinking, or has an
interest in designing a well-oiled guild. Recipes exist so a
working configuration can move from the person who built it to the
person who needs it.

If builders share real-world recipes, the same expertise can serve
day-to-day work beyond programming.
