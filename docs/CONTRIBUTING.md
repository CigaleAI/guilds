# Contributing

guilds.run is developed in the open under the GNU Affero General
Public License, version 3 only ([LICENSE](../LICENSE)).

A contribution is licensed under the same terms by the act of
submitting it. There is no separate contributor agreement.

- Request a feature: [Feature requests](#feature-requests).
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

A change is a branch and a pull request against `main`.

`make check` runs what CI runs. The pre-push hook runs it for you.
A pull request whose check passes is ready for review. What it
contains and what its reviewer checks is in
[Pull requests](contributing/pull-requests.md).

Keep a change to one thing. Update the documentation page that
describes what it changes in the same commit. Add a security
register entry when the change fixes a security issue.

## Feature requests

A feature request is a GitHub issue on this repository with the
label `feature request`. Open it from the
[feature request form](https://github.com/CigaleAI/guilds/issues/new?template=feature_request.yml&labels=feature%20request).
The form applies the label.

Write the issue in three parts:

- **Need.** The job you are trying to do, and what the product
  does not do for it today.
- **Proposal.** What an operator should be able to see or do
  once the feature exists. Leave the implementation out.
- **Out of scope.** What this request leaves unchanged.

One feature per issue. A need without a proposal is enough; say
that the proposal is open.

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
