# Changelog

A version is `MAJOR.MINOR.PATCH`, tagged `vMAJOR.MINOR.PATCH`.
The digit that changes is what a running box does.

| From | To | Effect | The box |
| --- | --- | --- | --- |
| `1.2.3` | `1.2.4` | No impact | Stays as it is. The images it runs did not change |
| `1.2.3` | `1.3.0` | Rebuild | Rebuilds the images. State, `.env`, recipes, and the API stay valid. Migrations apply at boot |
| `1.2.3` | `2.0.0` | Breaking | Is not compatible with the previous major. Back up, then follow the steps in that version |

A fix inside an image is a minor version. A patch does not change
the images a box runs. Several changes in one version take the
highest digit.

The rebuild commands are on
[Operate](docs/getting-started/operate.md#update).
How a version is cut is in
[Contributing](docs/CONTRIBUTING.md#versions).

No numbered release yet.
