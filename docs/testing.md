# Testing the shared JavaScript runtime

Verification is layered so a failure identifies the broken boundary instead of
merely reporting that the umbrella package failed.

| Gate | Command | Evidence |
|---|---|---|
| Version contract | `npm run verify:version` | npm, Rust, test package, exact dependency train, and `next` agree |
| Rust adapter | `cargo test --manifest-path rust/Cargo.toml --all-targets` | Browser/WASI adapter compiles against the selected family sources |
| Browser WASM | `npm test` after `npm run build:wasm` | Snapshot, collection, WFST, and query behavior |
| Node native | `npm run test:native` | N-API surface and TypeScript declaration parity |
| Native lifetime | `npm run test:leak` | 10,000-cycle resource steady-state checks |
| Native properties | `npm run test:property` | Deterministic fast-check oracles for distance, matching, values, and WFSTs |
| WASI | `npm run build:wasi && npm test` | Linear-memory ABI and persistent ARTrie preopen behavior |
| Package contents | `npm run verify:package` | Native loaders, browser WASM, WASI, and declarations present; source-only files absent |

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
```

The bootstrap defaults to sibling checkouts under the parent directory.
Override any source with `VINARY_TREE_<COMPONENT>_ROOT`; the accepted names are
printed by `npm run configure:local`. The generated `.cargo/config.toml`, SDK,
Cargo outputs, WASM outputs, and prebuilds are ignored and must never be
committed.

On a family feature branch, CI probes each authoritative component repository
for a branch with the same name. It checks out that branch when it exists and
uses the component's stable development baseline otherwise (`master`, or the
pinned `llattice` release). This per-component resolution lets one integration
branch exercise coordinated ABI changes without making an unrelated repository
invent a placeholder branch. A `release/*` train remains strict: every mutable
family component must provide the coordinated release branch, while `llattice`
stays on its immutable pinned release. Release workflows never use this
development resolver; they consume only the immutable tags in
`release/version.json`.

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
