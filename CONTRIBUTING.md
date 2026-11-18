# Contributing to Orbit

Thanks for looking. Bug reports and pull requests are welcome at
[github.com/fkallmer/zotero-orbit](https://github.com/fkallmer/zotero-orbit/issues).
For anything larger than a fix, open an issue first so we can agree on the shape
before you spend time on it.

## Setup

You need Node 26 (see `.node-version`) and Yarn via Corepack.

```sh
corepack enable
yarn install
```

## Building

```sh
yarn build                    # → .scaffold/build/orbit.xpi, raises the patch version
ORBIT_NO_BUMP=1 yarn build    # the same, leaving the version alone
yarn start                    # a Zotero with the plugin loaded and reloaded on change
```

Every `yarn build` raises the patch version. Zotero keys an installed plugin by
version, and two builds sharing one are the same plugin as far as it is
concerned — reinstalling can leave the old code in place. Set
`ORBIT_NO_BUMP=1` when you only want to check that a branch builds, and for a
release whose version was set by hand (`yarn release:build` does).

## Tests

```sh
yarn test:unit                         # Node tests, test/**/*.test.ts
yarn tsc -p tsconfig.test.json --noEmit
yarn test:coverage                     # runs the suite and rewrites the README badges
yarn test                              # the specs in test/zotero, inside a real Zotero
yarn lint:check                        # Prettier and ESLint, as CI runs them
```

`yarn test` launches Zotero itself and has to be told where it is, or it stops
at `No Zotero Found.` before starting anything. Put the path in an untracked
`.env`, which the scaffold reads:

```sh
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero
```

It runs against its own profile and data directory under `.scaffold/test/`, so
your library is not involved. Close any running Zotero first, and expect the
test window to stay open when the run ends — the command returns once it is
closed. CI runs the same specs on Linux in the `zotero-runtime-linux` job.

Specs that create items save them with `saveTx({ skipNotifier: true })`: with
**Fetch for new items** on, a notified add would send the test item to the
citation sources.

## How the code is laid out

- `src/modules/*.core.ts` hold pure logic — no Zotero, no DOM — and are tested
  directly by Node. Put anything that can be pure there.
- The other modules talk to Zotero and are covered by render tests (linkedom)
  and the runtime specs.
- There are no test-only seams in `src`. If something is hard to test, move the
  decision into a core module.
- `src/modules/collectionTypes.ts` holds the shapes the collection analysis is
  built from. Change them on purpose, not in passing.
- Cached shapes in `orbit-cache.json` only gain optional fields. A
  `CACHE_VERSION` bump empties every user's cache on upgrade; it is the right
  call only when an old entry would crash, not when it merely lacks a field.

Commit messages are plain sentences that say what changed and why, without
`feat:`-style prefixes.

## The contact address in local builds

Crossref offers a faster request pool to callers who identify themselves, and
the address for it is a setting (**Settings → Orbit → Contact address**). Each
user enters their own, which is the only arrangement that works for a published
plugin: an address compiled into a release would identify whoever built it on
every request every user makes.

A local build can still carry one, as a fallback for when the setting is empty:
put it in `.orbit-contact` (untracked) or set `ORBIT_CONTACT`. Released builds
are made without it. The address is deliberately not in this repository — it
identifies whoever runs the build, and a fork must not go on sending an address
that is not theirs — and a setting that is filled in always wins over it.

## Screenshots

The README pictures are made from public papers, never from a personal library.
`utils/screenshot-pane.mjs` renders the item pane outside Zotero; its header
explains how to capture it with a headless browser.

## Releasing

1. Set `"version"` in `package.json` by hand.
2. `yarn release:build` (builds with `ORBIT_NO_BUMP=1` and lints).
3. Add the release to `CHANGELOG.md`, commit, tag `vX.Y.Z`, push, and attach
   `.scaffold/build/orbit.xpi` to the GitHub release.
4. Replace `update.json` on the **Update channel** release (tag `release`),
   which is where every installed copy looks for updates:
   `gh release upload release .scaffold/build/update.json --clobber`.
   Without this step Zotero never offers the new version. The file's hash
   must match the attached `.xpi`, so upload both from the same build.
