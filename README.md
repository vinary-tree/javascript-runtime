# Vinary Tree JavaScript runtime

`@vinary-tree/vinary-tree` is the single-instance JavaScript runtime for
libdictenstein, liblevenshtein, lling-llang, and duallity. It lets their
project-specific facades exchange retained dictionaries and weighted
finite-state transducers (WFSTs) without copying or loading incompatible native
runtimes.

| Release property | Value |
|---|---|
| Candidate | `4.0.0-rc.2` |
| npm dist-tag | `next` |
| Node | 22.14 or newer |
| Backends | Native N-API, browser WebAssembly, Node WASI |
| License | Apache-2.0 |

## Install the release candidate

```sh
npm install @vinary-tree/vinary-tree@next
```

Use the package root for Node's native backend,
`@vinary-tree/vinary-tree/wasm` in a browser, or
`@vinary-tree/vinary-tree/wasi` when Node/WASI filesystem preopens are needed.
Applications normally install a project facade rather than importing the
shared runtime directly.

## Natural JavaScript collections and resources

Dictionaries follow the synchronous `Map` vocabulary while retaining explicit
native lifetime control:

```js
import { libdictenstein, liblevenshtein } from "@vinary-tree/vinary-tree";

using dictionary = libdictenstein.dynamicDawg("unicode");
dictionary.set("cat", 1n).set("cot", 2n).set("cut", null);

using transducer = liblevenshtein.transducer(dictionary);
using matches = transducer.query("cat", 1, "distance-then-term");

for (const { term, distance, id } of matches) {
  console.log(term.value, distance, id);
}
```

`size`, `set`, `get`, `has`, `delete`, `entries`, `keys`, `values`,
`forEach`, and `[Symbol.iterator]` mirror familiar collection behavior.
Ordinary iteration materializes one host-owned immutable revision, so early
loop exit leaks no native cursor. Large traversals use `streamEntries()`, a
bounded iterator with `nextBatch`, `reduceBatches`, `return`, `close`, and
`Symbol.dispose`.

The same ownership rule applies to query cursors, phonetic patterns, rule sets,
builders, transducers, and WFSTs: prefer `using` or call `close()` in `finally`.
Garbage collection is exceptional-path containment, not resource scheduling.

## Backend contract

| Import | Backend | Intended host |
|---|---|---|
| `@vinary-tree/vinary-tree` | Prebuilt N-API addon | Node services and tools |
| `@vinary-tree/vinary-tree/wasm` | `wasm-bindgen` module | Browsers and web workers |
| `@vinary-tree/vinary-tree/wasi` | Explicit WASI linear-memory ABI | Node with preopened persistent storage |

All three expose the same snapshot, collection, query, and WFST semantics.
Resources carry an immutable runtime identity; passing a resource between
different package instances fails before native dispatch.

## Standalone local development

The runtime is intentionally not nested in any core project. Put the five
family repositories beside this one, synchronize them to the release version,
then construct the development-only overlay and relocatable native SDK:

```sh
npm run configure:local
npm run bootstrap:native
npm run build:native:release
npm run stage:native
npm run test:native
```

`configure:local` writes an ignored `.cargo/config.toml` containing exact local
crate patches and portable Gxhash intrinsic requirements. `bootstrap:native`
builds the four public static libraries and stages them with the canonical
headers under `.build/native-sdk`; `binding.gyp` never reaches into sibling
directories.

## Documentation

- [Architecture and invariants](docs/architecture.md)
- [Testing strategy and property models](docs/testing.md)
- [Release order, platform matrix, and rollback](docs/releasing.md)
- [History-preserving extraction provenance](docs/extraction-provenance.md)

The project-specific packages own their idiomatic user APIs. This repository
owns only the common native/WASM/WASI implementation, runtime identity, package
assembly, and cross-project integration tests.
