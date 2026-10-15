# Contributing

guilds.run is developed in the open under the GNU Affero General
Public License, version 3 only ([LICENSE](../LICENSE)).

A contribution is licensed under the same terms by the act of
submitting it. There is no separate contributor agreement.

- Set up a development machine and run the check:
  [Development](contributing/development.md).
- Write code the way the repository does:
  [Code guidelines](contributing/code-guidelines.md).
- Understand the system before changing it: start at the
  [index](README.md) and [Philosophy](philosophy.md), then the
  [Architecture](README.md#architecture) pages.
- Talk with other operators and contributors:
  [Community](contributing/community.md).

A change is a branch and a pull request against `main`.

`make check` runs what CI runs. The pre-push hook runs it for you.
A pull request whose check passes is ready for review.

Keep a change to one thing. Update the documentation page that
describes what it changes in the same commit. Add a security
register entry when the change fixes a security issue.

Security issues are reported privately, never as a public issue:
[SECURITY.md](../SECURITY.md).
