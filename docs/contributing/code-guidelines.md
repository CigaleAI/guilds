# Code guidelines

These rules apply to everyone who writes code here, humans and
agents alike.

The goal is code a reader can trust without opening it. A reader
sees a function's name and signature and knows exactly what it
does, what it needs, and what it returns. The body can be as long
as that contract needs. Behaviour lives next to the code that uses
it.

ESLint, Prettier, the boundary rule, and the check enforce what
they cover. No lint rule enforces the function rules below; review
checks them. The tooling is in [Development](development.md).

---

## Functions

A function has one contract: the name and the signature say
everything it does. Nothing happens inside that the name does not
promise, including side effects. If the name needs an "and", it is
two functions.

- A function has at most **3 parameters**. If you need more, pass
  one object with named fields.
- A function has a **cyclomatic complexity of 10 or less**. A flat
  body with many early returns is fine; the limit exists to keep one
  function from holding several contracts.
- Nesting goes at most **2 levels** deep. Use early returns to
  stay flat. Nesting is what makes a body hard to read, so this
  limit is the strict one.
- Parameters are typed for what they are. A function does not take
  `Record<string, unknown>` or `unknown` when the caller has a type.
- A function does not take a flag that selects between behaviours.
  Each behaviour is its own function with its own name.

**What counts towards complexity:** `if`, `else if`, `case`, loops,
`&&`, `||`, `??`, ternaries (`a ? b : c`), and `catch`. A JSX
conditional (`cond && <X />`) counts like any other `&&`.

A function has no line limit. A long body with one contract is
better than a short body that calls six helpers a reader has to
chase. A
nested condition, a loop with a branch inside, or a second `switch`
becomes a named function only when that piece has a contract of
its own that a reader would want to know by name. A chain of `if`s
over a value is a lookup table.

A private helper exists because it names a real step, not to make
its caller shorter. A helper called from one place, whose name is
only meaningful inside its caller, is inlined.

## Tests

Every branch in new code has a unit test. Test names describe
behaviour (`returns_empty_list_when_no_orders`). A good test
suite reads like a description of what the code does.

Where the tests live is [Development](development.md#tests).

## Names

A name says what the thing does. A reader does not open the body.

The test is **no surprises**: a reader who knows only the name and
the signature predicts the result and every effect. A function
whose name is a step of its caller (`part`, `step`, `apply`,
`handle`, `process`) and means nothing on its own is not a
function; it is a block of its caller.

- Functions are a verb over a domain noun (`resolveModelCredentials`,
  `seedOperator`, `materialiseScripts`). The verb is specific:
  `resolve`, `load`, `write`, `format`, `validate`, not `get`,
  `handle`, `process`, `do`.
- Two functions that differ in behaviour differ in name, in the
  part of the name that carries the difference
  (`readAgentFile`, `readAgentFolder`).
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

## Locality

Code lives next to the code that uses it. A reader understands one
behaviour from one file. A jump to another file is a cost, and the
reader pays it only to reach a contract worth knowing by name.

Two pieces of code are the same function only when they have the
**same contract**: same inputs, same output, same promise. Then
there is one function, with one name, and both callers use it.

Two pieces of code that look alike but promise different things
are two functions. Each gets a specific name that says how it
differs, and the body is repeated. Repeating most of a body is
cheaper than a shared helper that needs a flag, a mode string, or a
loose type to serve both callers. That helper has no contract of
its own, and it couples two behaviours that will change apart.

Code moves out of a feature into a shared directory when a second
caller with the identical contract exists, not before.

## Scaffolding

We group files by feature, not by type. One directory per
feature, flat inside it.

In the orchestrator each domain is a directory under `src/`
(`schedules/`, `secrets/`, `recipes/`). It holds the files for
that domain named for what they hold (`service.ts`, `timing.ts`,
`access.ts`). Nothing goes deeper unless the domain has a
sub-domain of its own.

A file holds one concern and stays under **800 lines**. A file
that grows past that is split by sub-domain (`routes/agents.ts`,
`routes/schedules.ts`), never by type (`helpers.ts`, `types.ts`).
A reader, human or agent, loads one file to understand one
behaviour, and a file that holds every behaviour of a layer costs
the whole layer to read and makes every edit collide.

In the operator app each screen is a directory under
`src/features/`. Code the screens share lives in two directories:
`src/api/` (the HTTP client, queries, streams, and the API types) and
`src/app/` (the app root, the router, extension slots, and formatting).
There is no `utils/`, `helpers/`, or `common/`.

```
src/
  api/
    ...
  app/
    ...
  features/
    recipes/
      ...
    studio/
      ...
```

- Each feature lives in its own folder.
- Folders stay flat: `features/<name>/<file>`. A sub-folder is a
  sub-domain, not a type (`components/`, `hooks/`).
- Code two domains share goes in the shared directory (`lib/` in the
  orchestrator, `api/` or `app/` in the operator app) and says which
  two.

HTTP stays thin in `http/`. A route handler reads the request,
calls one domain function, and writes the reply. It does not
import `db/` and does not validate, decide, or query on its own.
The domain module owns the logic and the validation. A feature's
tests are named for the feature.

The inside of a feature can change freely. Other code reaches it
through what that feature exports.

## Shared code

A shared directory (`lib/` in the orchestrator, `api/` and `app/` in
the operator app) holds code shared across features. It must stay
clean, or it becomes a junk drawer.

Code belongs there only if:

- It is used by **at least two features**.
- It contains **no feature-specific knowledge**.
- It does one very specific thing.
- It is a **pure function** where possible.
- Every branch has a test.
- Its name says exactly what it does and is easy to find by search.

A shared directory never imports from a feature.

## Boundaries

A module reaches another through what that module exports. A
package is reached through its `exports` list.

A feature may import from a shared directory. Prefer not to import
from another feature; when two features must share behaviour, move
that behaviour to a shared directory or keep a thin call at the composition
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

A pure function is easy to test and its contract is complete: the
signature is the whole promise.

## Types and errors

TypeScript is strict everywhere. Input is validated at the edge,
once: TypeBox schemas on routes, a validation module per domain
for what arrives from the operator or the model.

Inside the domain the types are trusted. `any` does not appear.

A repository returns typed rows. A function in `db/` declares a
row type per table (`AgentRow`, `ScheduleRow`) and returns it; it
does not return `Record<string, unknown>`. A domain that receives
a row reads its fields by name without `String(row.x)` guards,
because the type is the contract.

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
discussion. The
[security register](../architecture/security-register.md) keeps
the history of each security issue. Release history is the
[changelog](../../CHANGELOG.md).

A change to behaviour updates the page that describes it in the
same commit.

Write in **simple, short sentences**. Explain it like you would
to a beginner.

A page under `docs/getting-started/`, listed under **Get started**
in the [index](../README.md#get-started), is a tutorial. It is
written for someone who has never seen the product:

- The subject comes first, then the verb. One action per sentence.
- Steps are in the imperative: open, click, paste, type.
- Each step ends with what the reader sees.
- A word the reader has not met is defined in a sentence of its own,
  or linked, before it is used.
- A sentence says what is, not what is not.
- No parentheses, no chained colons, no file paths, no HTTP verbs.
  Depth lives on a concept page, reached by a link.

A page under **Concepts** explains one concept. One concept has one
page. It teaches first and keeps the exact detail at the bottom,
under these headings, in this order:

1. The title, then one or two plain paragraphs: what it is, and how
   it relates to the concepts next to it. No column names, routes, or
   file paths.
2. **Why it exists** or **When you use it**.
3. **How it works**: the mental model. A diagram where a flow or a
   hierarchy is easier seen than read.
4. **In the app**: where the operator sees and changes it.
5. **Rules and limits**: a short table of defaults, caps, and
   refusals.
6. **Reference**: complete and exact. Fields, configuration keys,
   HTTP routes, storage, and edge cases.

A heading with nothing to say is left out. Everything above
**Reference** reads on its own.

Every other page is reference, `docs/operations/` included. It is
complete and exact, and it follows the same sentence rules where
they do not cost precision.

## Changes

One change does one thing. The commit message is one sentence in
the imperative that states the outcome for the reader of
`git log`. A short body is used only when the why is not obvious.

Before you call a task done, run `make check`
([Development](development.md#check)). It runs lint and the tests.

If a rule seems to block the task, ask. Do not work around the
rule.

The pre-push hook runs the whole check on what is pushed.

---

## Checklist

Before you submit a change, check:

- [ ] Each function's name and signature say everything it does.
      No flag parameters, complexity of 10 or less, nesting of 2 or
      less, 3 parameters or fewer.
- [ ] Every file is under 800 lines and holds one concern.
- [ ] Rows leave `db/` typed; route handlers call one domain
      function and never touch `db/`.
- [ ] No helper exists only to shorten its caller.
- [ ] Every new branch has a test.
- [ ] I searched for existing code before writing new code.
- [ ] Names are clear and do not overlap with existing names.
- [ ] Code shared between callers has one contract; code that
      differs has two names.
- [ ] Shared code meets the shared-code rules.
- [ ] Side effects are at the edges.
- [ ] Docs are updated in the same change.
- [ ] Lint and tests pass.
