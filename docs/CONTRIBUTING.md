# Contributing

guilds.run is developed in the open under the GNU Affero General
Public License, version 3 only ([LICENSE](../LICENSE)).

A contribution is licensed under the same terms by the act of
submitting it. There is no separate contributor agreement.

- Report a bug, request a feature, or propose a chore:
  [Issues](#issues).
- Cut a version: [Versions](#versions).
- Set up a development machine and run the check:
  [Development](contributing/development.md).
- Write code the way the repository does:
  [Code guidelines](contributing/code-guidelines.md), or
  [The rules in brief](contributing/rules-in-brief.md) on one page.
- Understand the system before changing it: start at the
  [index](README.md) and [Philosophy](philosophy.md), then the
  [Architecture](README.md#architecture) pages.
- Talk with other operators and contributors on
  [Discord](https://discord.gg/aqp5aPq9Uh) or
  [X](https://x.com/guildsrun).

A change is a branch and a pull request against `main`. What it
contains and what its reviewer checks is in
[Pull requests](contributing/pull-requests.md).

## Issues

An issue is a bug, a feature, or a chore, one per issue, opened
from its [form](https://github.com/CigaleAI/guilds/issues/new/choose).
The form labels it `bug`, `feature request`, or `chore`. A feature
needs only its **Why** to be opened; the proposal can stay open.

An issue is complete when every field holds an answer and no
field holds a question:

- **Outcome.** One sentence in the imperative.
- **Why.** The job the operator is doing and what goes wrong today
  without the change. For a chore, what the broken rule costs.
  Never the solution.
- **Where.** The doc page that describes the behaviour today, and
  the entry point: a route, an agent tool, a Studio view, or a
  domain directory.
- **Behaviour.** A bug: the steps, what happens, what should
  happen. A feature: what the operator sees and does, with the
  refusals. A chore: the rule broken, named from the
  [code guidelines](contributing/code-guidelines.md), and the file
  that breaks it.
- **Verification.** The test that fails today and passes when done,
  as suite and assertion. For a view, the steps a person runs in
  the app and what they see.
- **Size.** One pull request
  ([Pull requests](contributing/pull-requests.md#size)): a single
  feature, fix, or chore, complete on its own, with its routes,
  tests, and docs pages; no concept the [glossary](GLOSSARY.md)
  lacks. Its steps are that pull request's commits. A need that
  holds two such changes is two issues, neither waiting on the
  other.
- **Out of scope.** What stays as it is.
- **Breaks.** None, or the route, event, type, export, or storage
  format that changes.

Security issues never go through this path ([Security](#security)).

## Versions

A release is a git tag `vMAJOR.MINOR.PATCH` and an entry at the
top of the [changelog](../CHANGELOG.md). Versions follow
[Semantic Versioning](https://semver.org/).

| Digit | A version moves it when |
|---|---|
| Major (`1.2.3` to `2.0.0`) | It is breaking: a box, an API client, a recipe, or an extension that works on the previous version needs a change to work on this one, or a migration removes stored data |
| Minor (`1.2.3` to `1.3.0`) | It adds behaviour and breaks nothing |
| Patch (`1.2.3` to `1.2.4`) | It only fixes |

While the major digit is 0, a breaking version moves the minor
digit and every other version moves the patch digit. Several
changes in one release take the highest digit.

An entry is the version and, in this order:

- A first paragraph that opens with **Breaking.** or **Not
  breaking.** and says what the version is.
- **Upgrade**: the numbered steps that take a box from the previous
  version to this one. A breaking version starts with the backup and
  names every step past the update commands
  ([Maintain](operations/maintain.md#update)): a setting to add, a
  port to open, a choice to make again in the app.
- **Breaking changes**, in a breaking version: each break, as what
  holds now, what its migration does to stored data, and what its
  reader changes: an operator, an API client, a recipe, an extension.
- **Added**, **Changed**, and **Fixed**: what an operator can see.
- **Security**: the [Security register](architecture/security-register.md)
  entries the version adds or closes.

Changes not yet tagged sit under `## Unreleased` at the top, a
heading the first of them adds. There each change is one paragraph
that opens with its kind in bold: **Breaking.**, **Added.**,
**Changed.**, or **Fixed.** A breaking paragraph states its
migration: what the box does to stored data at boot, and what an
operator, an API client, a recipe, or an extension changes. A break
that does not reach every box names whom it reaches, such as
**Breaking for extensions.** Cutting a version writes the entry from
these paragraphs and removes the heading.

Pushing the tag publishes the images
([Development](contributing/development.md#ci)).

## Security

Security issues are reported privately, never as a public issue:
[SECURITY.md](../SECURITY.md).
