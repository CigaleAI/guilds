# Code guidelines

These rules apply to everyone who writes code here, humans and
agents alike.

The goal is simple code. We write small, clear functions. We
combine them to build bigger behaviour.

If a tool can check a rule, a tool checks it. Reviewers focus on
the rest. The lint, format, and check tooling is in
[Development](development.md).

---

## Functions

A function does one thing. It should be easy to read in one pass.

- A function has at most **30 lines**.
- A function has at most **3 branches** (cyclomatic complexity of
  4 or less).
- A function has at most **3 parameters**. If you need more, pass
  one object.
- Nesting goes at most **2 levels** deep. Use early returns to
  stay flat.

**What counts as a branch:** `if`, `else if`, `case`, `&&`, `||`,
ternaries (`a ? b : c`), and `catch`.

A nested condition, a loop with a branch inside, or a second
`switch` becomes a named function. A chain of `if`s over a value
is a lookup table. A function that takes a flag to do two things
is two functions.

Do not split code into tiny pieces just to pass the limits. Every
function must have a name that makes sense on its own. If you
need to jump between many files to understand one behaviour, the
split is wrong.

## Tests

Every branch in new code has a unit test. Test names describe
behaviour (`returns_empty_list_when_no_orders`). A good test
suite reads like a description of what the code does.

Where the tests live is [Development](development.md#tests).

## Names

A name says what the thing does. A reader does not open the body.

- Functions are a verb over a domain noun (`resolveModelCredentials`,
  `seedOperator`, `materialiseScripts`).
- Types and tables are the domain noun (`Repositories`,
  `artifact_collections`).
- Booleans read as a question (`isReadOnlyRemote`).

One concept has one name. Do not use `getUser` in one place and
`fetchUser` in another for the same thing.

Search before you write. Look for an existing function before you
create a new one.

Abbreviations are the domain's own (`org`, `id`, `mcp`) and
nothing else. A name that needs a comment to be understood is the
wrong name.

## Duplication

Do not copy and paste logic.

Follow the **rule of three**: when similar code appears for the
third time, extract it into a shared function. Similar code in
two features is acceptable. Merging too early creates coupling
between features.

## Scaffolding

We group files by feature, not by type. One directory per
feature, flat inside it.

In the orchestrator each domain is a directory under `src/`
(`schedules/`, `secrets/`, `recipes/`). It holds the files for
that domain named for what they hold (`service.ts`, `timing.ts`,
`access.ts`). Nothing goes deeper unless the domain has a
sub-domain of its own.

In the operator app each screen is a directory under
`src/features/`. There is no `utils/`, `helpers/`, or `common/`.

```
src/
  features/
    recipes/
      ...
    studio/
      ...
  lib/
    ...
```

- Each feature lives in its own folder.
- Folders stay flat: `features/<name>/<file>`. A sub-folder is a
  sub-domain, not a type (`components/`, `hooks/`).
- Code two domains share goes in `lib/` and says which two.

HTTP stays thin in `http/`. The domain module owns the logic and
the validation. A feature's tests are named for the feature.

The inside of a feature can change freely. Other code reaches it
through what that feature exports.

## Shared code

`lib/` holds code shared across features. It must stay clean, or
it becomes a junk drawer.

Code belongs in `lib/` only if:

- It is used by **at least two features**.
- It contains **no feature-specific knowledge**.
- It does one very specific thing.
- It is a **pure function** where possible.
- Every branch has a test.
- The function name perfectly describe what it does and is easy to find by search

`lib/` never imports from a feature.

## Boundaries

A module reaches another through what that module exports. A
package is reached through its `exports` list.

A feature may import from `lib/`. Prefer not to import from
another feature; when two features must share behaviour, move
that behaviour to `lib/` or keep a thin call at the composition
root (`compose.ts`, the router, a page that mounts both).

Core imports nothing from an edition built on it.
`eslint.boundary.js` fails the file that tries.

An edition attaches through the
[extension points](../architecture/extension-points.md). A need
it has that core lacks becomes an extension point with a core
default, not a branch.

## Pure core, side effects at the edges

Business logic lives in **pure functions**. Same input, same
output, no side effects.

Side effects (database, network, files, time, randomness) live in
**thin outer functions**. The outer functions call the pure ones.

Pure functions are easy to test, easy to reuse, and easy to
compose.

## Types and errors

TypeScript is strict everywhere. Input is validated at the edge,
once: TypeBox schemas on routes, a validation module per domain
for what arrives from the operator or the model.

Inside the domain the types are trusted. `any` does not appear.

Public functions have **explicit types** for inputs and outputs.
Types are documentation that cannot go out of date.

Use **one error-handling pattern**. A domain throws a named
error class (`RecipeError`, `MachineConflict`). HTTP maps that
class to `HttpError` and a status. Do not mix thrown strings,
ad-hoc objects, and classes for the same kind of failure.

## Clean code

- No dead code.
- No commented-out code. Version control remembers it.
- Do not change files that are unrelated to your task.

## Comments and documentation

A comment says why, not what. The code says what.

Every page under `docs/` describes what the code does today,
in the present tense, with no history, roadmap, or record of a
discussion. The one exception is the
[security register](../architecture/security-register.md), which
keeps the history of each issue.

A change to behaviour updates the page that describes it in the
same commit.

Write in **simple, short sentences**. Explain it like you would
to a beginner.

A page listed under **Get started** in the
[index](../README.md#get-started) is a tutorial. It is written
for someone who has never seen the product:

- The subject comes first, then the verb. One action per sentence.
- Steps are in the imperative: open, click, paste, type.
- Each step ends with what the reader sees.
- A word the reader has not met is defined in a sentence of its own,
  or linked, before it is used.
- A sentence says what is, not what is not.
- No parentheses, no chained colons, no file paths, no HTTP verbs.
  Depth lives on a concept page, reached by a link.

Every other page is reference. It is complete and exact, and it
follows the same sentence rules where they do not cost precision.

## Changes

One change does one thing. The commit message is one sentence in
the imperative that states the outcome for the reader of
`git log`. A short body is used only when the why is not obvious.

Before you call a task done, run lint, tests, and the check in
[Development](development.md#check).

If a rule seems to block the task, ask. Do not work around the
rule.

The pre-push hook runs the whole check on what is pushed.

---

## Checklist

Before you submit a change, check:

- [ ] Functions are short, with 3 branches or fewer and 3
      parameters or fewer.
- [ ] Every new branch has a test.
- [ ] I searched for existing code before writing new code.
- [ ] Names are clear and do not overlap with existing names.
- [ ] Shared code in `lib/` meets the shared-code rules.
- [ ] Side effects are at the edges.
- [ ] Docs are updated in the same change.
- [ ] Lint and tests pass.
