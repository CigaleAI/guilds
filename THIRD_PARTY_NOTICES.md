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
| npm packages | The orchestrator image and the operator app's bundle | Each package's own: MIT, Apache-2.0, ISC, BSD, BlueOak-1.0.0, 0BSD, Unlicense, and one LGPL-3.0-only library (`rpc-websockets`). `pnpm licenses list --prod` prints them all |

## Built or fetched beside it

| What | How | Licence |
|---|---|---|
| OpenSandbox, by the OpenSandbox authors | `scripts/images.sh` builds its server from a pinned commit; its JavaScript SDK is an npm dependency | Apache-2.0 |
| Google Chrome | The runtime image's build downloads it from Google on amd64 | Google's terms; it is not redistributed with this repository |
| Chromium | The runtime image's build installs Debian's package on arm64 | BSD-3-Clause and others, as packaged by Debian |
| PostgreSQL | Pulled as `postgres:17` | PostgreSQL License |
