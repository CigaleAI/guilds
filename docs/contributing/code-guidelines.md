# Code guidelines

These rules apply to everyone who writes code here, humans and
agents alike. The goal is code a reader can trust without opening
it: a function's name and signature say what it does, what it
needs, and what it returns, and behaviour lives next to the code
that uses it.

ESLint enforces the limits below and the boundary rules
([Lint](development.md#lint-and-format)). The other rules are
checked in review ([Pull requests](pull-requests.md)).

---

## Functions

A function has one contract: the name and the signature say
everything it does. Nothing happens inside that the name does not
promise, including side effects. If the name needs an "and", it is
two functions.

- A function has at most **4 parameters**. ESLint warns at 5 and
  fails at 6.
- An object parameter is one of two kinds, and its type is always
  a named type:
  - A **record** names a thing that exists in the application
    outside this call (a new row, a patch, a key, a spec, an editing
    session) and holds only that thing's fields. A settings type is
    a record when several callers and instances share it.
  - A **dependencies object** holds the services a module needs. It
    could be built once at composition and reused by every call, so
    it never holds a per-call value such as the user or the actor.

  A React component's props object is the component's record.
  Every other object parameter is an argument bag and is not
  allowed. That includes an inline object type of optional settings,
  and a type named after its function that bundles the call's
  arguments; neither brings a function under the parameter limit.
  Call context (the clock, the actor, a transaction client, a hook)
  is a parameter of its own, never a field of a record or a
  dependencies object.
- A function has a **cyclomatic complexity of 11 or less**. A flat
  body with many early returns is fine; the limit exists to keep one
  function from holding several contracts.
- Nesting goes at most **3 levels** deep. A `try` block counts as
  a level in review; ESLint does not count it. Use early returns to
  stay flat. Nesting is what makes a body hard to read, so this
  limit is the strict one.
- Parameters are typed for what they are. A function does not take
  `Record<string, unknown>` or `unknown` when the caller has a type.
- A function does not take a flag that selects between behaviours.
  Each behaviour is its own function with its own name. A boolean
  that selects a behaviour is a flag wherever it sits, in a
  parameter of its own or inside an object; a boolean that is data,
  such as a field of a patch, is not.

**What counts towards complexity:** `if`, `else if`, `case`, loops,
`&&`, `||`, `??`, ternaries (`a ? b : c`), and `catch`. A JSX
conditional (`cond && <X />`) counts like any other `&&`.

A function has no line limit. A long body with one contract is
better than a short body that calls six helpers a reader has to
chase. A nested condition, a loop with a branch inside, or a second
`switch` becomes a named function only when that piece has a
contract of its own that a reader would want to know by name. A
chain of `if`s over a value is a lookup table.

A private helper exists because it names a real step, not to make
its caller shorter. A helper called from one place, whose name is
only meaningful inside its caller, is inlined.

## Tests

Every branch in new code has a unit test. Test names describe
behaviour (`returns_empty_list_when_no_orders`). A good test
suite reads like a description of what the code does. Where the
tests live is [Development](development.md#tests).

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
- Types and tables are the domain noun (`ArtifactStore`,
  `artifact_collections`).
- Booleans read as a question (`isReadOnlyRemote`).

One concept has one name. Do not use `getUser` in one place and
`fetchUser` in another for the same thing. Search before you
write: look for an existing function before you create a new one.

Abbreviations are the domain's own (`org`, `id`, `mcp`) and
nothing else. A name that needs a comment to be understood is the
wrong name.

## Locality

Code lives next to the code that uses it. A reader understands one
behaviour from one file, and pays a jump to another file only to
reach a contract worth knowing by name.

Two pieces of code are the same function only when they have the
**same contract**: same inputs, same output, same promise. Then
there is one function, with one name, and both callers use it.
Two pieces that look alike but promise different things are two
functions, each with a specific name that says how it differs, and
the body is repeated. Repeating most of a body is cheaper than a
shared helper that needs a flag, a mode string, or a loose type to
serve both callers: that helper has no contract of its own, and it
couples two behaviours that will change apart.

Code moves to a shared directory (`lib/` in the orchestrator,
`api/` or `app/` in the operator app) when a second feature calls
it with the identical contract, not before. Shared code holds no
feature-specific knowledge, is a pure function where possible, and
has a name easy to find by search. A shared directory never imports
from a feature.

## Scaffolding

Files are grouped by feature, not by type: one directory per
feature, flat inside it. In the orchestrator each domain is a
directory under `src/` (`schedules/`, `secrets/`, `recipes/`) whose
files are named for what they hold (`service.ts`, `timing.ts`,
`access.ts`). In the operator app each screen is a directory under
`src/features/`, and the code the screens share is `src/api/` (the
HTTP client, queries, streams, and the API types) and `src/app/`
(the app root, the router, extension slots, and formatting). There
is no `utils/`, `helpers/`, or `common/`. A sub-directory is a
sub-domain, never a type (`components/`, `hooks/`).

A file holds one concern and stays under **800 lines**. A file
that grows past that is split by sub-domain (`http/agent-routes.ts`,
`http/run-routes.ts`), never by type (`helpers.ts`, `utils.ts`). A
domain's `types.ts` is not such a split: it is the shapes the domain
shows to others, and other domains import it directly. A reader
loads one file to understand one behaviour, and a file that holds
every behaviour of a layer costs the whole layer to read and makes
every edit collide.

HTTP stays thin in `http/`. A route handler reads the request,
calls one domain function, and writes the reply. It does not
import `db/` and does not validate, decide, or query on its own. A
rule several routes would repeat, such as what happens after a
named error, is one function in the domain that owns it.

## Boundaries

A module reaches another through what that module exports. A
package is reached through its `exports` list. A module that only
re-exports others does not exist, except an index a tool requires,
such as the schema mirror's.

In the orchestrator the domains form a stack of value imports: a
domain imports no value from a domain above it, and `db/` and
`lib/` are the bottom. A type imported from above is not a cycle,
but it is a shape the lower domain speaks in and a sign that the
concept may belong to it. A domain that reaches another calls one
named function of the module that owns the behaviour. A file or a
domain that enters an import cycle fails the check
([Lint](development.md#lint-and-format)).

An import that points up the stack is a leak. The fix moves what
leaked, not the import:

- **Wiring**: a caller builds a domain's dependencies object. The
  domain's public functions take a `Queryable` instead.
- **Rule**: a caller re-derives a domain's rule from its data. The
  domain exports the rule as one named function.
- **Ownership**: a concept sits in the wrong domain, so both import
  each other. The concept moves to the domain that owns it.
- **Shape**: a caller parses a representation. It is parsed once, at
  the boundary, into a named type.
- **Callback**: a caller passes a function in so the domain need not
  import it. The domain imports what it calls. A function arrives
  only as a service in a dependencies object, built where the
  application is composed or faked in a test.

Core imports nothing from an extension built on it.
`eslint.boundary.js` fails the file that tries.

A domain module imports the `db/` modules it reads and writes
through, and its public functions take a `Queryable` as their
connection. Where a unit test fakes the database, the domain binds
its own dependencies object of the `db/` functions it calls, each
bound to the connection with `bindQuery`, and writes that commit
together run in a transaction bound beside them with
`bindTransaction`. That object is built inside the domain, from the
`Queryable` its public function received; a caller never builds it.
Nothing else stands between a domain module and `db/`: no facade,
no class that forwards every query. Only `http/` is kept out of
`db/`.

`db/` imports nothing outside `db/` and `lib/`, and `lib/` nothing
outside `lib/`. `db/` holds the queries and the types and defaults
of what it stores. The validation, the decisions, and the change
records a write needs belong to the domain module that calls it,
which opens the transaction they share.

A domain module imports nothing from the HTTP framework. Only
`http/`, the app and composition roots, the extension points and
the observability hooks import `fastify`.

Custom code attaches through the
[extension points](../architecture/extension-points.md). A need
it has that core lacks becomes an extension point with a core
default, not a branch.

## Pure core, side effects at the edges

Business logic lives in **pure functions**: same input, same
output, no side effects. Side effects (database, network, files,
time, randomness) live in **thin outer functions** that call the
pure ones. A pure function is easy to test and its contract is
complete: the signature is the whole promise.

## Types and errors

TypeScript is strict everywhere. Input is validated at the edge,
once: TypeBox schemas on routes, a validation module per domain
for what arrives from the operator or the model. Inside the domain
the types are trusted. `any` does not appear.

A repository returns typed rows. Row types are derived from the
Drizzle schema in `db/schema/`, never written out by hand: a table's
row is `InferSelectModel<typeof table>`, a projection is a `Pick` or
`Omit` of it, and a joined column takes the type of the column it
reads (`Agent["name"] | null` for a left join). `db/` declares a
field's type itself only for a value a query computes, such as a
count or a JSON aggregate. A column list in SQL is built from the
same keys (`tableColumns`, `pickColumns` in `db/columns.ts`), so the
query and its type cannot drift apart. A write's input takes each
column's type from the row (`IssueRow["status"]`). A repository
does not return `Record<string, unknown>`. A domain that receives
a row reads its fields by name without `String(row.x)` guards,
because the type is the contract.

Public functions have **explicit types** for inputs and outputs.
Types are documentation that cannot go out of date.

A cast creates no knowledge. The only type assertion is `as const`.
A value whose shape is unknown is validated or narrowed with a type
guard, never asserted.

Use **one error-handling pattern**. A domain throws a named
error class (`RecipeError`, `MachineConflict`). HTTP maps that
class to `HttpError` and a status. Do not mix thrown strings,
ad-hoc objects, and classes for the same kind of failure.

A `catch` does one of two things: it throws a named error, or it
returns a value whose type says the failure was expected, such as
`null` from a lookup of something that may be absent. A `catch`
that logs and continues, or returns a default that hides the
failure, does not appear.

## Clean code

- No dead code.
- No commented-out code. Version control remembers it.
- Do not change files that are unrelated to your task.
- If a rule seems to block the task, ask. Do not work around the
  rule.

## Comments and documentation

A comment says why, not what. The code says what.

Every page under `docs/` describes what the code does today, in
the present tense, with no history, roadmap, or record of a
discussion. How a page is written is
[Documentation](development.md#documentation).

---

## Checklist

Before you submit a change, check:

- [ ] Each function's name and signature say everything it does.
      No flag parameters, complexity of 11 or less, nesting of 3 or
      less, 4 parameters or fewer, object parameters only for
      records and dependencies objects.
- [ ] Every file is under 800 lines and holds one concern.
- [ ] Rows leave `db/` typed; route handlers call one domain
      function and never touch `db/`.
- [ ] No import points up the stack, and no function is passed in
      to avoid one.
- [ ] No type assertion but `as const`; every `catch` throws a
      named error or returns an expected absence.
- [ ] No helper exists only to shorten its caller.
- [ ] Every new branch has a test.
- [ ] I searched for existing code before writing new code.
- [ ] Names are clear and do not overlap with existing names.
- [ ] Code shared between callers has one contract; code that
      differs has two names.
- [ ] Side effects are at the edges.
