# AI Agent Directives & Project Rules

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
