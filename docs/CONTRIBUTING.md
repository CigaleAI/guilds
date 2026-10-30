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
  [Code guidelines](contributing/code-guidelines.md).
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
A feature needs only its **Why**; the proposal can stay open.

An issue is **ready** when a maintainer has labelled it `ready`,
and that label is given only when every field holds an answer and
no field holds a question:

- **Outcome.** One sentence in the imperative. It is the pull
  request's title.
- **Why.** The job the operator is doing and what goes wrong today
  without the change. For a chore, what the broken rule costs.
  Never the solution. It is the pull request's *Why*.
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
- **Size.** One domain directory under `src/`, with its routes,
  tests, and docs page; no concept the [glossary](GLOSSARY.md)
  lacks; no schema change unless the issue is the migration and
  nothing else; three commits or fewer. A larger need is split into
  issues each ready on its own before any is labelled.
- **Out of scope.** What stays as it is.
- **Breaks.** None, or the route, event, type, export, or storage
  format that changes.

A ready issue is implemented as one pull request
([Pull requests](contributing/pull-requests.md)) whose *Why* names
it. An agent takes only a ready issue, and answers a missing field
with a comment, not a guess. Security issues never go through this
path ([Security](#security)).

## Versions

A release is a git tag `vMAJOR.MINOR.PATCH` and an entry at the
top of the [changelog](../CHANGELOG.md).

Move one digit. It names the effect on a running box:

| Digit | Effect | The box |
|---|---|---|
| Patch (`1.2.3` to `1.2.4`) | `no impact` | Stays as it is. Docs, tooling, or anything the images do not run changed |
| Minor (`1.2.3` to `1.3.0`) | `rebuild` | Rebuilds its images. State, `.env`, recipes, and the API stay valid. Migrations apply at boot |
| Major (`1.2.3` to `2.0.0`) | `breaking` | Cannot run this tree unchanged. The entry leads with the steps |

A fix that changes an image is a minor version. Several changes
in one release take the highest digit.

The entry is the version, the effect, and what an operator can
see. Changes not yet tagged sit under **Unreleased** at the top.

The commands a box runs for each effect are in
[Maintain](operations/maintain.md#update).

Pushing the tag publishes the images
([Development](contributing/development.md#ci)).

## Security

Security issues are reported privately, never as a public issue:
[SECURITY.md](../SECURITY.md).
