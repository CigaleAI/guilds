# Code guidelines

These rules apply to everyone who writes code here, humans and
agents alike. The goal is code a reader can trust without opening
it: a function's name and signature say what it does, what it
needs, and what it returns, and behaviour lives next to the code
that uses it.

Most of this code is written by agents and read by people, and a
name and a signature are all either has to go on. The types are
therefore the application's data model, not a check to pass: a
type names a thing the application has, holds that thing's fields,
and is the one abstraction every caller of it shares. A change that
satisfies a rule without naming a thing (a looser type, a cast, a
helper that hides the shape) makes the model wrong, and review
refuses it.

Oxlint and the import-cycle check
([Lint](development.md#lint-and-format)) enforce these rules:

- nesting depth and file length, and a warning on cyclomatic
  complexity and parameter count;
- a function with more than one block of nested conditional logic;
- type assertions;
- a `catch`, or a promise's `.catch()`, that neither throws nor
  returns a value;
- a throw of a plain `Error`;
- an object type written inline in a parameter;
- an export whose return type is `unknown` or
  `Record<string, unknown>`, and a type alias that is only one of
  them;
- a parameter typed `unknown` or `object`, outside a type predicate
  and the modules that parse input; a dictionary whose value type
  is `unknown`, `any`, `object` or `{}`; a `typeof` check outside a
  type guard; a `Record<string, T>` annotation on a value whose
  keys are known; a reducer that copies its accumulator; and a
  module mock in a test;
- explicit types on what an orchestrator module exports;
- imports of `fastify`, a value import of `db/` from `http/`, and
  what `db/` and `lib/` import;
- a shared directory of the operator app importing a feature;
- re-exports;
- imports of an extension's code or of code outside the repository;
- import cycles.

Every other rule on this page is checked in review
([Pull requests](pull-requests.md)).

---

## Functions

A function has one contract: the name and the signature say
everything it does. Nothing happens inside that the name does not
promise, including side effects. If the name needs an "and", it is
two functions.

- A function has at most **4 parameters**. Lint warns at 5.
- An object parameter is one of two kinds, and its type is always
  a named type:
  - A **record** names a thing that exists in the application
    outside this call (a new row, a patch, a key, a spec, an editing
    session) and holds only that thing's fields. A settings type is
    a record when several callers and instances share it.
  - A **dependencies object** holds the services a module needs. It
    is built once in a composition root, or faked in a test, and
    reused by every call, so it never holds a per-call value: the
    user, the actor, an org id, a guild id, and the clock are never
    its fields. A `Queryable` that is the application's connection
    pool is the same for every call, so it may be a field. A
    transaction client is call context, not the pool.

  A record is named for the thing it holds, never for the function
  that takes it. In the operator app:
  - A React component's props object is the component's record. It
    is named `<Component>Props` and declared beside the component.
  - Every other record, such as what a call sends or addresses (a
    mutation's variables, the owner a query key names, a patch), is
    named for that thing (`AccessOwner`, `ScheduleUpdate`) and
    declared in the feature's `types.ts`, or in the API's module of
    its domain under `api/types/` when the API shares it.

  Every other object parameter is an argument bag and is not
  allowed. That includes an inline object type that lists a
  function's arguments, an inline object type of optional settings,
  and a type named after its function that bundles the call's
  arguments; none of them brings a function under the parameter
  limit. An argument bag is unbundled into parameters. A function
  that needs more than four parameters has two contracts and is
  split along them.
  Call context (the clock, the actor, a transaction client, a hook)
  is a parameter of its own, never a field of a record or a
  dependencies object.
- A function has a **cyclomatic complexity of 11 or less**, as
  Oxlint counts it. Lint warns past 11.
- Nesting goes at most **3 levels** deep. A `try` block counts as
  a level, and Oxlint counts it with the others. Use early returns
  to stay flat. Nesting is what makes a body hard to read, so this
  limit is the strict one. A function declared inside another, a
  closure or a function declaration, counts towards the function
  that declares it; a method is a function of its own. A function
  holds at most **one block of nested conditional logic**: one
  conditional or loop statement at the top of its body that holds
  another.
- Parameters are typed for what they are. A function does not take
  `Record<string, unknown>` or `unknown` when the caller has a type.
- A function does not take a flag that selects between behaviours.
  Each behaviour is its own function with its own name. A boolean
  that selects a behaviour is a flag wherever it sits, in a
  parameter of its own or inside an object; a boolean that is data,
  such as a field of a patch, is not.

**What counts towards complexity:** `if`, `else if`, `case`, loops,
`&&`, `||`, `??`, ternaries (`a ? b : c`), `catch`, a default value
(`x = 1`), optional chaining (`a?.b`), and the logical assignments
(`??=`, `||=`, `&&=`). An `if` that returns early counts like any
other `if`. A JSX conditional (`cond && <X />`) counts like any
other `&&`.

The parameter and complexity limits are evidence, not the rule. A
function past one of them is read for its contracts: one that holds
two is split along them; one that holds one keeps its body, and the
pull request names it with the contract it holds
([Pull requests](pull-requests.md#content)). A split made to pass
the number, or a record made to bring a function under the
parameter limit, is refused.

A function has no line limit. A long body with one contract is
better than a short body that calls six helpers a reader has to
chase. A nested condition, a loop with a branch inside, or a second
`switch` becomes a named function only when that piece has a
contract of its own that a reader would want to know by name. A
chain of `if`s over a value is a lookup table.

A private helper exists because it names a real step, not to make
its caller shorter. A helper called from one place, whose name is
only meaningful inside its caller, is inlined. A function over the
complexity limit is split along a step a reader would want to know
by name, never along a line count.

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

The test of a shape is the work it asks of a reader. A reader new to
the code answers two questions about any value without a chase:
where it comes from, and what can change it. A layer (a wrapper, an
adapter, a helper) or a piece of state (a field, a module variable)
is added only when it removes at least as much of that work
elsewhere. Lines, complexity and the number of layers are evidence
for this test, not the test.

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

A composition root assembles the application: in the orchestrator
`src/compose.ts` and `src/app.ts`, in the operator app
`src/app/router.tsx`. A composition root imports every feature it
assembles, so the rule that a shared directory never imports from a
feature excludes it, even where it sits in a shared directory.

## Scaffolding

Files are grouped by feature, not by type: one directory per
feature, flat inside it. In the orchestrator each domain is a
directory under `src/` (`schedules/`, `secrets/`, `recipes/`) whose
files are named for what they hold (`service.ts`, `timing.ts`,
`access.ts`). In the operator app each screen is a directory under
`src/features/`. The code the screens share is in two directories:

- `src/api/` talks to the server: the HTTP client, the live streams,
  the guards in `wire.ts` that narrow what the server sends, and one
  module per domain under `queries/` and `types/`.
- `src/app/` holds the app itself: the app root, the router,
  extension slots, and the pieces every feature uses, such as
  formatting (`format.ts`), name rules (`names.ts`), and the
  list-detail layout (`MasterDetail.tsx`).

There is no `utils/`, `helpers/`, or `common/`. A sub-directory is a
sub-domain, never a type (`components/`, `hooks/`).

A file holds one concern and stays under **800 lines**. Lint
warns past 800 and fails at 1,000. A file that grows past the limit
is split by sub-domain (`http/agent-routes.ts`,
`http/run-routes.ts`), never by type (`helpers.ts`, `utils.ts`). A
domain's `types.ts` is not such a split: it is the shapes the domain
shows to others and the records its calls send, and other domains
import it directly. A reader
loads one file to understand one behaviour, and a file that holds
every behaviour of a layer costs the whole layer to read and makes
every edit collide.

HTTP stays thin in `http/`. A route handler reads the request,
including who makes it, calls one domain function, and writes the
reply in its wire shape. It imports no value from `db/` and does
not validate, decide, or query on its own. A rule several routes would
repeat, such as who may see a resource or what happens after a
named error, is one function in the domain that owns it. A route
that calls several domain functions in turn is the domain missing
one.

## Boundaries

A module reaches another through what that module exports. A
package is reached through its `exports` list. A module exports
what it declares and does not hand on another module's exports,
except an index a tool requires, such as the schema mirror's.

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

- **Wiring**: a caller binds a domain's `db/` functions for it. The
  domain binds its own from the `Queryable` it holds.
- **Rule**: a caller re-derives a domain's rule from its data. The
  domain exports the rule as one named function.
- **Ownership**: a concept sits in the wrong domain, so both import
  each other. The concept moves to the domain that owns it.
- **Shape**: a caller parses a representation. It is parsed once, at
  the boundary, into a named type.
- **Callback**: a caller passes a function in so the domain need not
  import it. The domain imports what it calls. A function arrives
  only as a service in a dependencies object, built in a
  composition root (`src/compose.ts`, `src/app.ts`,
  `src/app/router.tsx`) or faked in a test.

Core imports nothing from an extension built on it.
`lint/boundary.js` fails the file that tries.

A domain module imports the `db/` modules it reads and writes
through, and holds a `Queryable` as its connection: a parameter of
its public functions, or the application's connection pool as a
field of its dependencies object. Where a unit test fakes the
database, the domain binds its own object of the `db/` functions it
calls, each bound to that `Queryable` with `bindQuery`, and writes
that commit together run in a transaction bound beside them with
`bindTransaction`. That bound object is built inside the domain,
from the `Queryable` it holds; a caller never builds it. A
dependencies object built in a composition root holds the services
a domain needs, such as a blob store, a policy, or the connection
pool. A transaction client is call context: it is a parameter of
its own, never a field of a dependencies object. Nothing else
stands between a domain module and `db/`: no facade, no class that
forwards every query. Only `http/` is kept out of `db/`.

`db/` imports nothing outside `db/` and `lib/`, and `lib/` nothing
outside `lib/`. `db/` holds the queries and the types and defaults
of what it stores. The validation, the decisions, and the change
records a write needs belong to the domain module that calls it,
which opens the transaction they share.

A domain module imports nothing from the HTTP framework. Only
`http/`, the orchestrator's composition roots, the extension points
and the observability hooks import `fastify`.

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

Every value that crosses a function boundary has a type that names
what it is in the application (`CreateGuildPayload`,
`ScheduleUpdate`, `Agent["name"]`). That type is declared once,
where the thing is owned, and imported by everyone who handles it;
before writing a type, search for the one that exists, because two
types for one thing are two models. A value that arrives from
outside (a request, a model's output, a connector's response, a
stored JSON column) is parsed once, at the edge, into such a type,
and after that no function asks what it is. `unknown` appears only
as the parameter of that parser or of a type predicate.
`Record<string, unknown>` is not a type: it says that nobody has
decided what the value is. Where the application truly makes no
claim about a shape, the value is `JsonValue` or `JsonObject`, and
the place that reads a field out of it is where a type is missing.

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
      No flag parameters, nesting of 3 or less, object parameters
      only for records and dependencies objects. A function past the
      complexity or parameter limit holds one contract, named in the
      pull request.
- [ ] A reader new to the code can say where each value comes from
      and what changes it without a chase; no layer or state was
      added that does not remove more elsewhere.
- [ ] A dependencies object holds services and at most the
      connection pool; a transaction client and every per-call value
      are parameters of their own.
- [ ] Every file is under 800 lines and holds one concern.
- [ ] Rows leave `db/` typed; route handlers call one domain
      function and import no value from `db/`.
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
