# Testing the shared JavaScript runtime

Verification is layered so a failure identifies the broken boundary instead of
merely reporting that the umbrella package failed.

| Gate | Command | Evidence |
|---|---|---|
| Version contract | `npm run verify:version` | npm, Rust, test package, exact dependency train, and `next` agree |
| Rust adapter | `cargo test --manifest-path rust/Cargo.toml --all-targets` | Browser/WASI adapter compiles against the selected family sources |
| Browser WASM | `npm test` after `npm run build:wasm` | Snapshot, collection, query, built-in WFST, and host-provider behavior |
| Node native | `npm run test:native` | N-API surface and TypeScript declaration parity |
| Native lifetime | `npm run test:leak` | 10,000-cycle resource steady-state checks |
| Native properties | `npm run test:property` | Deterministic fast-check oracles for distance, matching, values, and WFSTs |
| WASI | `npm run build:wasi && npm test` | Linear-memory ABI, generational host providers, and persistent ARTrie preopen behavior |
| Package contents | `npm run verify:package` | Native loaders, browser WASM, WASI, and declarations present; source-only files absent |
| Installed family consumer | `npm run verify:installed-family-consumer` after all builds | Offline npm tarballs of the runtime, interop, and duallity expose configured WFST options and cache controls through native ESM/CommonJS, TypeScript and ClojureScript entries, browser WASM, and WASI; installed TypeScript declarations compile and a ClojureScript consumer compiles and executes |

## Local sequence

The family repositories must first carry the versions listed in
`release/version.json`.

```sh
npm run configure:local
npm run bootstrap:native
npm run build:native:release
npm run stage:native
npm run test:native
npm run test:leak
npm run test:property
npm run build:wasm
npm run build:wasi
npm test
npm run verify:installed-family-consumer
```

The bootstrap defaults to sibling checkouts under the parent directory.
Override any source with `VINARY_TREE_<COMPONENT>_ROOT`; the accepted names are
printed by `npm run configure:local`. The generated `.cargo/config.toml`, SDK,
Cargo outputs, WASM outputs, and prebuilds are ignored and must never be
committed.

The installed-family gate packs all three local RC.6 npm packages without
publishing them, installs only those tarballs into an isolated offline consumer,
checks the actual package exports, and deletes the scratch installation and npm
cache afterward. In Node, its browser-WASM probe supplies a file-URL fetch
adapter solely to emulate a browser loading the emitted WASM asset; the tested
JavaScript and binary are the same bytes packaged for browsers. This gate is
distinct from the mock-based facade unit tests: it verifies the real resource
ABI and both package boundaries.
The ClojureScript probe compiles the package's actual `.cljs` namespace with
the pinned ClojureScript compiler and executes a configured WFST through the
installed CommonJS facade, checking the idiomatic map conversion and cache
controls. Its JVM temporary files stay inside the deleted consumer scratch
directory rather than on a memory-backed system temporary mount.

## Hosted development source graph

The hosted integration job checks out six sibling source repositories before
building the runtime. Until the coordinated RC.6 provider-cache and universal
automaton changes reach their upstream `master` branches, a development run
whose baseline is `master` selects these two compatible source refs:

| Source repository | Transitional development ref | Required by duallity `master` |
| --- | --- | --- |
| lling-llang | `codex/vco-feature-integration` | Provider cache controls and configured WFST ownership |
| liblevenshtein-rust | `codex/universal-variant-semantics` | Padded characteristic vectors and accepting-distance semantics |

The other development sources remain on `master`, except llattice, which uses
`v0.1.0`. The workflow-dispatch `development_refs_json` map overrides either
transitional ref explicitly; a coordinated `release/*` baseline ignores both
defaults. The immutable release `sourceRefs` in `release/version.json` are not
changed by this development bridge. Remove each transitional default after its
source branch has been merged into `master` and the same locked duallity build
passes against the resulting master-only graph.

## Property-test model

The native property suite compares optimized functions against small direct
oracles. For a dictionary $`D`$, query $`q`$, and maximum distance $`k`$, the
expected term set is:

```math
M(D,q,k)=\{t\in D\mid d_{\mathrm{Lev}}(q,t)\le k\}.
```

The suite also pins threshold equivalence, order monotonicity, the complete
unsigned 64-bit value range, and deterministic WFST construction. Fixed seeds
and committed examples make every failure reproducible.

The host-provider suites cover method and option validation, byte/Unicode/u64
labels, bounded paging, totals that change between pages, pages that make no
progress, NaN and wrong-type fields, thrown exceptions followed by recovery,
recursive callback attempts, source close during an active call, retained
composition snapshots, lattice domain isolation, batch-capability
renegotiation, representative lattice-law probes, idempotent disposal, 4,096
WASI slot-reuse cycles, and 10,000-cycle native memory steady state.
