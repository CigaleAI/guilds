# The rules in brief

The code rules of this repository on one page, for an agent's brief
or a reviewer who knows the long form. Every sentence here is a rule
of [Code guidelines](code-guidelines.md), [Pull requests](pull-requests.md)
or [Development](development.md); a rule changes there first, and
those pages carry the rationale, the examples and the tooling.

## The model of the code

1. **The name and the signature are the whole contract.** A reader
   trusts a function without opening it. One function, one contract;
   an "and" in the name is two functions. No flag parameters. An
   object parameter is a record (a thing the application has, named
   for it) or a dependencies object (services, built once, never a
   per-call value); anything else is an argument bag and is unbundled.
   Call context (clock, actor, transaction client) is a parameter of
   its own. A helper exists because it names a real step, never to
   shorten its caller; one called from one place with a name that
   means nothing outside its caller is inlined.
2. **The types are the application's data model.** A type names a
   thing the application has, holds its fields, and is declared once
   where the thing is owned. Input is parsed once at the edge (TypeBox
   on routes, a validation module per domain) into such a type; after
   that no function asks what a value is. `unknown` appears only as a
   parser's or a type predicate's parameter; `Record<string, unknown>`
   is not a type; `any` does not appear. Rows derive from the Drizzle
   schema, never by hand. No assertion but `as const`.
3. **Behaviour lives next to the code that uses it.** One directory
   per feature, flat, files named for what they hold; no `utils/`,
   `helpers/`, `common/`. Code moves to `lib/`, `api/` or `app/` when
   a second feature calls it with the identical contract. Two bodies
   that promise different things are two functions with two names,
   even when they look alike. A file holds one concern and splits by
   sub-domain, never by type.
4. **Modules talk through what they export, and the graph is a
   stack.** No re-exports. A domain imports no value from a domain
   above it; `db/` and `lib/` are the bottom, `db/` imports only `db/`
   and `lib/`, `lib/` only `lib/`. An import that points up is a leak,
   and the fix moves what leaked, never the import. A route reads the
   request, calls one domain function, writes the reply; it imports
   no value from `db/` and does not validate, decide or query. Only
   `http/`, the roots, the extension points and observability import
   `fastify`.
5. **One pattern per concern.** A domain throws a named error class;
   `http/` maps it to a status. A `catch` throws a named error or
   returns a typed absence; it never logs and continues. One concept,
   one name; search before writing. Pure core, side effects at the
   edges: a function that loads evidence and formats it is a load that
   returns a named record and a pure format of that record.

## The limits

| Measure | Limit | Enforced |
|---|---|---|
| Parameters | 4 | lint warns at 5 |
| Cyclomatic complexity | 11 | lint warns past 11 |
| Nesting | 3 levels, `try` counts | lint error |
| Blocks of nested conditional logic | 1 per function | lint error |
| File length | 800 lines | lint warns past 800, fails at 1,000 |

A closure counts towards the function that declares it; a method is
its own function. A chain of `if`s over a value is a lookup table.

Complexity and parameter count are evidence, not the rule. A function
past one of them is read for its contracts: one that holds two is
split along them; one that holds one keeps its body, and the pull
request names it under Limits with the contract it holds. A split made
to pass the number, or a record made to pass the parameter limit, is
refused. A function has no line limit.

Lint also refuses: a silent `catch` or `.catch()`, a plain `Error`
outside `cli/`, an inline object type in a parameter, an export that
returns `unknown` or `Record<string, unknown>`, a parameter typed
`unknown` or `object` outside parsers and type predicates, a
dictionary valued `unknown`, `any`, `object` or `{}`, a `typeof`
outside a type guard, a `Record<string, T>` on known keys, a reducer
that copies its accumulator, a module mock in a test, an untyped
export in the orchestrator, an import cycle, and a shared directory
of the operator app importing a feature. Tests, stories and scripts
are exempt from the limits and the type rules. Legacy violations sit
in each package's `lint-suppressions.json`, which only shrinks.

## Names

A reader who knows only the name and the signature predicts the
result and every effect. Functions are a specific verb over a domain
noun (`resolve`, `load`, `write`, `format`, `validate`; not `get`,
`handle`, `process`, `do`). Two functions that differ in behaviour
differ in the part of the name that carries the difference. Types and
tables are the domain noun; booleans read as a question.
Abbreviations are the domain's own. A name that needs a comment is
the wrong name.

## Tests and docs

Every branch in new code has a unit test, named for the behaviour.
Every service a change touches has an end-to-end test through that
service's edge (a route through `app.inject`, a tool through the
tool call, a view through its model). A test fakes a dependency
through the seam the code offers, never the module system. A comment
says why, not what. Every page under `docs/` describes the current
state only; the change updates the page that describes what it
touches, in the same commit.

## A change

One pull request does one thing; its title is that sentence. Each
commit is one step that passes the check on its own; a move or a
rename is its own commit, before the change that needs it. The
description has Why, What, Breaks, Assumptions (each gap the author
filled, what the change does because of it, and what the operator
could say to change it; "None" when empty) and Limits. Nothing is
kept backward compatible by default; a break is listed. A fix to
suppressed code ends with `pnpm lint --write` so the entries leave;
only a commit that adds a rule may add entries, and it adds nothing
else. `make check` passes on the branch tip.

**Refused**, whatever the check says: a type alias that is only
`unknown` or `Record<string, unknown>`; a type named after its
function that bundles its arguments; a catch that returns a value
whose type does not say absence; a function split by line count into
helpers named for steps; a cast moved into a helper or removed by
widening; an `unknown` replaced by another type that names nothing;
a type declared a second time; code moved under a test or scripts
path to leave the lint globs; a limit raised, an ignore widened, a
suppressions file regenerated instead of pruned. If a rule seems to
block the task, ask; do not work around it.

## Before you submit

- [ ] Each function's name and signature say everything it does; no
      flag, nesting of 3 or less, one block of nested logic, object
      parameters only for records and dependencies objects.
- [ ] A reader new to the code can say where each value comes from
      and what changes it without a chase.
- [ ] A dependencies object holds services and at most the connection
      pool; every per-call value is a parameter of its own.
- [ ] Every file is under 800 lines and holds one concern.
- [ ] Rows leave `db/` typed; routes call one domain function and
      import no value from `db/`; no import points up the stack.
- [ ] No type assertion but `as const`; every `catch` throws a named
      error or returns an expected absence.
- [ ] No helper exists only to shorten its caller; no dead or
      commented-out code; no unrelated file changed.
- [ ] Every new branch has a test; names do not overlap existing
      ones; I searched before writing.
- [ ] Side effects are at the edges.
