The OpenSandbox TypeScript SDK is consumed from git commit
`473ff611d93670a149ce6600f27ed194b18cce89`, subdirectory
`sdks/sandbox/javascript`, package name `@alibaba-group/opensandbox`.

Evidence at that commit:

- `package.json` `main` / `exports` point at `./dist/index.js`.
- `files` lists `dist` and `src`, but `dist/` is not in the git tree.
- Scripts are `gen:api` + `tsup` under `build`. There is no `prepare`.
- A bare pnpm git dependency therefore does not self-build.

R1 install result (option (a) attempted):

- `pnpm-lock.yaml` pins
  `github:opensandbox-group/OpenSandbox#473ff611d93670a149ce6600f27ed194b18cce89&path:sdks/sandbox/javascript`
  resolved as the GitHub tarball for that commit plus `path:sdks/sandbox/javascript`.
- pnpm applies the package `files` field, so the installed tree is `src/`
  plus `package.json` / `README.md`. `scripts/`, `tsup` config, and `dist/`
  are absent. SHA-256 of the installed `src/` tree (path + bytes, files
  sorted) is
  `2c874b47762c78d35e50c8530c8f670dd15f6267229dd7d2b8858a743b4e5b29`
  (45 files).
- A `pnpm.patchedDependencies` `prepare` script cannot run `pnpm run build`
  on that tree: `gen:api` and `tsup` are not packed, and both are
  devDependencies (not installed for a dependency).

R1 choice: **keep the git pin without a prepare patch**. The SDK is not
imported by `/health`. R3 wires the wrapper and, if `dist/` is still
required, switches to option (b): a vendored workspace package from a
sparse checkout of the same commit with a source-tree checksum, so the
build scripts are present.

The published npm `0.1.11` is not the pin.
