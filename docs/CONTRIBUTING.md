# Contributing

guilds.run is developed in the open under the GNU Affero General
Public License, version 3 only ([LICENSE](../LICENSE)).

A contribution is licensed under the same terms by the act of
submitting it. There is no separate contributor agreement.

- Request a feature: [Feature requests](#feature-requests).
- Set up a development machine and run the check:
  [Development](contributing/development.md).
- Write code the way the repository does:
  [Code guidelines](contributing/code-guidelines.md).
- Understand the system before changing it: start at the
  [index](README.md) and [Philosophy](philosophy.md), then the
  [Architecture](README.md#architecture) pages.

A change is a branch and a pull request against `main`.

`make check` runs what CI runs. The pre-push hook runs it for you.
A pull request whose check passes is ready for review.

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

## Security

Security issues are reported privately, never as a public issue:
[SECURITY.md](../SECURITY.md).
