# Third-party notices

guilds.run is copyright Cigale AI and licensed under the GNU Affero
General Public License, version 3 only ([LICENSE](LICENSE)). It builds on
the work below, each under its own terms.

## Shipped in a build

| What | Where it ends up | Licence |
|---|---|---|
| Manrope, by Mikhail Sharanda (`@fontsource-variable/manrope`) | The operator app's stylesheet | SIL Open Font License 1.1 |
| JetBrains Mono, by JetBrains (`@fontsource/jetbrains-mono`) | The operator app's stylesheet | SIL Open Font License 1.1 |
| Clay, Cameo, Critters, and Pixelbot avatar styles, by DiceBear (`@dicebear/styles`) | Agent avatars the orchestrator draws | CC0 1.0 |
| Bottts Neutral avatar style, a remix of Bottts by Pablo Stanley (`@dicebear/styles`) | Agent avatars the orchestrator draws | Free for personal and commercial use (https://bottts.com/) |
| The OpenAI, Anthropic, OpenRouter, xAI, DeepInfra, and Kimi marks, as drawn in the models.dev repository (https://github.com/sst/models.dev) | The operator app's model setup and Model keys | The repository is MIT; each mark belongs to its owner and names that provider only |
| npm packages | The orchestrator image and the operator app's bundle | Each package's own: MIT, Apache-2.0, ISC, BSD-3-Clause, BlueOak-1.0.0, 0BSD, Unlicense, OFL-1.1, and CC0-1.0 OR MIT. `pnpm licenses list --prod` prints them all |

## Built or fetched beside it

| What | How | Licence |
|---|---|---|
| OpenSandbox, by the OpenSandbox authors | `scripts/images.sh` builds its server from a pinned commit; its JavaScript SDK is an npm dependency; the server pulls its `opensandbox/execd` image | Apache-2.0 |
| PostgreSQL | Pulled as `postgres:17` | PostgreSQL License |
| Python | The runtime image starts from `python:3.12-slim` | PSF License |
| Debian packages, Chromium among them | The runtime image's build installs them from Debian | Each package's own, as packaged by Debian |
| Google Chrome | The runtime image's build downloads it from Google on amd64, unless `BROWSER=chromium` | Google's terms; it is not redistributed with this repository |
| Playwright | The runtime image's build installs it with pip | Apache-2.0 |
| Node.js | The runtime image's build downloads it from nodejs.org | MIT |
| ttyd | The runtime image's build downloads it from its GitHub releases | MIT |
| GitHub CLI (`gh`) | The runtime image's build downloads it from its GitHub releases | MIT |
| mise | The runtime image's build downloads it from its GitHub releases | MIT |
| Codex CLI, by OpenAI | The runtime image's build installs it from npm | Apache-2.0 |
| Claude Code, by Anthropic | The runtime image's build installs it from npm when `HARNESSES` names it, as it does by default | Anthropic's terms; it is not redistributed with this repository |
| Cursor CLI, by Anysphere | The runtime image's build downloads it from Cursor when `HARNESSES` names it, as it does by default | Cursor's terms; it is not redistributed with this repository |
| Antigravity CLI, by Google | The runtime image's build downloads it from Google when `HARNESSES` names it, as it does by default | Google's terms; it is not redistributed with this repository |
