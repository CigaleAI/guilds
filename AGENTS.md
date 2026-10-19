# AI Agent Directives & Project Rules

## 0. General rules

- When amending anything, find the general case the trigger belongs to and change that. A change phrased in terms of the instance that prompted it only covers that instance: it carries the assumption that no other instance exists, and it conflicts with the next instance-level change made for a neighbouring case. The trigger is evidence of a class; the amendment addresses the class, and the trigger itself does not appear in it.

- Every output is written for whoever receives it, not for the conversation that produced it. Anything that is meaningful only relative to that conversation does not belong in the output: alternatives that were rejected, corrections that were made, the examples used to argue a point, qualifiers that answer a question someone raised along the way. State what is; state what is not only when the absence is itself a requirement. If the history matters, record it in a place dedicated to history, apart from the result.

## 1. Prompt Engineering & Refinement
- When asked to adjust or refine a prompt based on real-world examples, **never** hardcode or use the specifics from those examples in the new prompt. 
- You must abstract and generalize the underlying patterns. Using specific data from examples in the prompts is considered "cheating" and is strictly prohibited.

## 2. Code & Documentation Standards
- When writing or updating documentation and code, **never** leave artifacts of previous states, old implementations, or our past discussions.
- Code and docs must exclusively describe the current state of the project ("what is"). 
- Do not treat documentation as specifications, to-do lists, or conversation history. Keep files clean, authorittive, and strictly descriptive of the active implementation.
- The only exception is `docs/architecture/security-register.md`: it records security issues that were fixed or are still open, with their history. Add an entry for every security issue found, update its status when it is fixed, and never remove one.
- Refer to `docs/contributing/code-guidelines.md` for more details on the code guidelines.

## 3. Do not care about backward compatibility
- If some changes aren't backward compatible, you should flag it and let the operator choose how to handle this.
- Don't assume everything has to backward compatible


