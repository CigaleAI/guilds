# AI Agent Directives & Project Rules

- When amending anything, find the general case the trigger belongs to and change that. A change phrased in terms of the instance that prompted it only covers that instance: it carries the assumption that no other instance exists, and it conflicts with the next instance-level change made for a neighbouring case. The trigger is evidence of a class; the amendment addresses the class, and the trigger itself does not appear in it.

- Every output is written for whoever receives it, not for the conversation that produced it. Anything that is meaningful only relative to that conversation does not belong in the output: alternatives that were rejected, corrections that were made, the examples used to argue a point, qualifiers that answer a question someone raised along the way. State what is; state what is not only when the absence is itself a requirement. If the history matters, record it in a place dedicated to history, apart from the result.

- A prompt refined from real examples states the pattern the examples share. Nothing specific to an example appears in it.

An agent implements only an issue labelled `ready` ([Issues](docs/CONTRIBUTING.md#issues)), as one pull request whose *Why* names it; a missing field is a comment on the issue, not a guess. Code is held to the [code guidelines](docs/contributing/code-guidelines.md) and a change to [Pull requests](docs/contributing/pull-requests.md). Every page under `docs/` describes the current state only. The one exception is `docs/architecture/security-register.md`: it keeps every security issue with its history, gains an entry for each issue found, and never loses one.
