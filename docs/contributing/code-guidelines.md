# Code guidelines

What a change to this repository looks like. The lint, format, and
check tooling is in [Development](development.md).

## Names

A name says what the thing does. A reader does not open the body.

- Functions are a verb over a domain noun (`resolveModelCredentials`,
  `seedOperator`, `materialiseScripts`).
- Types and tables are the domain noun (`Repositories`,
  `artifact_collections`).
- Booleans read as a question (`isReadOnlyRemote`).

Abbreviations are the domain's own (`org`, `id`, `mcp`) and
nothing else. A name that needs a comment to be understood is the
wrong name.

## Functions

Functions are short and shallow. One function makes one kind of
decision.

A nested condition, a loop with a branch inside, or a second
`switch` becomes a named function. Return early. A chain of `if`s
over a value is a lookup table.

A function that takes a flag to do two things is two functions.
The cyclomatic complexity of a function is a reason to split it
before it is a reason to document it.

## Scaffolding

One directory per feature, flat inside it.

In the orchestrator each domain is a directory under `src/`
(`schedules/`, `secrets/`, `recipes/`). It holds the files for
that domain named for what they hold (`service.ts`, `timing.ts`,
`access.ts`). Nothing goes deeper unless the domain has a
sub-domain of its own.

In the operator app each screen is a directory under
`src/features/`. There is no `utils/`, `helpers/`, or `common/`.
Code two domains share goes in `lib/` and says which two.

HTTP stays thin in `http/`. The domain module owns the logic and
the validation. A feature's tests are named for the feature.

## Boundaries

A module reaches another through what that module exports. A
package is reached through its `exports` list.

Core imports nothing from an edition built on it.
`eslint.boundary.js` fails the file that tries.

An edition attaches through the
[extension points](../architecture/extension-points.md). A need
it has that core lacks becomes an extension point with a core
default, not a branch.

## Types and validation

TypeScript is strict everywhere. Input is validated at the edge,
once: TypeBox schemas on routes, a validation module per domain
for what arrives from the operator or the model.

Inside the domain the types are trusted. `any` does not appear.

## Comments and documentation

A comment says why, not what. The code says what.

Every page under `docs/` describes what the code does today,
in the present tense, with no history, roadmap, or record of a
discussion. The one exception is the
[security register](../architecture/security-register.md), which
keeps the history of each issue.

A change to behaviour updates the page that describes it in the
same commit.

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

## Commits

One change per commit. The message is one sentence in the
imperative that states the outcome for the reader of `git log`.
A short body is used only when the why is not obvious.

The pre-push hook runs the whole check on what is pushed.
