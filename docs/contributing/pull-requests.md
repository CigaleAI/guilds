# Pull requests

A pull request is one change against `main`, reviewed by someone
who did not write it. This page says what a pull request contains
and what its reviewer checks. The code itself is held to the
[Code guidelines](code-guidelines.md).

---

## Size

One pull request does one thing: one feature, one fix, one
refactor, one rename. A reader can state what it does in one
sentence, and that sentence is its title. A pull request has no
line limit; its commits do.

A commit is the unit a reviewer reads. Each commit does one step
of the pull request, reads as one sentence in `git log`, passes
the check on its own, and is small enough to hold in mind: a few
hundred lines that change meaning. Lines that only move (a file
split, a rename, a move between modules), generated files,
fixtures, lockfiles, and migrations do not count. A step that
needs more is split into commits that land one after the other:

- A rename or a move is its own commit, before the change that
  needs it.
- A migration is a commit with the code that reads the new schema,
  and nothing else.
- A new feature is its store, then its tools or routes, then its
  views, when each commit is useful or at least harmless on its
  own.
- A refactor adds the new function beside the old, moves one
  caller per commit, and deletes the old last.

A pull request is not rebased or squashed before review; its
commits are what the reviewer reads.

## Content

- **Title**: one sentence in the imperative that states the
  outcome, as the commit message does. A commit body is used only
  when the why is not obvious.
- **Description**: three parts, for a reader who has not seen the
  conversation that produced the change.
  - *Why*: the problem, the request, or the issue the pull request
    exists for, and what is wrong without it. For a refactor, the
    rule the code breaks and the backlog item that names it. A pull
    request whose reason cannot be stated is not opened.
  - *What*: what changes, and what is deliberately left out.
  - *Breaks*: anything that is not backward compatible: a changed
    route, event, type, export, or storage format. Nothing is kept
    backward compatible by default; a break is listed here and the
    operator chooses how to handle it.
- **End-to-end tests**: every service the change touches has a
  test that drives the changed behaviour through that service's
  edge, as its callers use it: an HTTP route through `app.inject`,
  an agent tool through the tool call, a view through its model.
  The test fails without the change and passes with it. A unit
  test of a helper does not stand in for it. A refactor keeps
  behaviour, so its description names the suites that reach the
  moved code instead, and adds a test where none does. Where the
  tests live is [Tests](development.md#tests).
- **Suppressions**: a fix to code listed in a package's
  `eslint-suppressions.json` ends with the prune, so the diff shows
  the entries leaving ([Lint](development.md#lint-and-format)). The
  only commit that adds entries is one that adds a rule, and it adds
  nothing else. The `suppressions` step of the
  [check](development.md#check) fails a commit of the branch, or a
  working tree, in which a package's total of suppressed errors
  grows, unless it changes only suppressions files, ESLint
  configurations (`eslint.*.js`) and pages under `docs/`.
  A fix satisfies the rule the entry names, not the
  selector that found it. The reviewer refuses a fix that:
  - declares a type alias whose body is `unknown` or
    `Record<string, unknown>`;
  - names a type after its function and bundles the function's
    arguments in it;
  - catches and returns a value whose type does not say absence, or
    a default that hides the failure;
  - splits a function by line count into helpers named for steps
    (`part`, `step`, `handle`);
  - moves a cast into a one-line helper, or removes it by widening a
    type to `unknown`;
  - moves code under a test, stories or scripts path to leave the
    lint globs;
  - raises a limit, widens an ignore list, or regenerates a
    suppressions file instead of pruning it.
- **Docs**: the page that describes what the change touches is
  updated in the same commit, and describes the new state only
  ([Documentation](development.md#documentation)).
- **Changelog**: a user-visible change has a line under
  `Unreleased` in `CHANGELOG.md`.
- **Security register**: a change that fixes or introduces a
  security issue adds or updates its entry in the
  [Security register](../architecture/security-register.md).
- **Check**: `make check` passes on the branch tip
  ([Check](development.md#check)).

## Review

The reviewer reads the diff, not the description, and checks:

1. **Reason**: the description says why the pull request exists,
   and the diff is the smallest change that answers it.
2. **Scope**: the diff does what the title says and nothing else,
   and each commit is one step of it, read on its own. An
   unrelated fix found on the way is its own pull request.
3. **Tests**: each touched service has an end-to-end test of the
   changed behaviour, each new branch is exercised, and the tests
   assert behaviour, not implementation. A refactor's named suites
   do reach the moved code.
4. **Guidelines**: the [checklist](code-guidelines.md#checklist)
   holds.
5. **Boundaries**: routes call one domain function; `db/` rows
   leave typed; no package reaches into another's internals.
6. **Docs**: every page that names the changed behaviour is
   updated, and no page describes a previous state.
7. **Compatibility**: every break the diff introduces is flagged in
   the description.

A comment asks for a change or asks a question. A pull request is
merged when the check passes and the reviewer has no open comment.
The author merges, with a merge commit, and deletes the branch.
