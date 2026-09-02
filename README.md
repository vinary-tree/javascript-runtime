# Vinary Tree JavaScript runtime

`@vinary-tree/javascript-runtime` is the single-instance JavaScript runtime for
libdictenstein, liblevenshtein, lling-llang, and duallity. It lets their
project-specific facades exchange retained dictionaries and weighted
finite-state transducers (WFSTs) without copying or loading incompatible native
runtimes.

| Release property | Value |
|---|---|
| Candidate | `4.0.0-rc.6` |
| npm dist-tag | `next` |
| Node | 22.14 or newer |
| Backends | Native N-API, browser WebAssembly, Node WASI |
| License | Apache-2.0 |

## Install the release candidate

```sh
npm install @vinary-tree/javascript-runtime@next
```

Use the package root for Node's native backend,
`@vinary-tree/javascript-runtime/wasm` in a browser, or
`@vinary-tree/javascript-runtime/wasi` when Node/WASI filesystem preopens are needed.
Applications normally install a project facade rather than importing the
shared runtime directly.

## Natural JavaScript collections and resources

Dictionaries follow the synchronous `Map` vocabulary while retaining explicit
native lifetime control:

```js
import { libdictenstein, liblevenshtein } from "@vinary-tree/javascript-runtime";

using dictionary = libdictenstein.dynamicDawg("unicode");
dictionary.set("cat", 1n).set("cot", 2n).set("cut", null);

using transducer = liblevenshtein.transducer(dictionary);
using matches = transducer.query("cat", 1, "distance-then-term");

for (const { term, distance, id } of matches) {
  console.log(term.value, distance, id);
}
```

Repeated searches can opt into the bounded, exact TinyLFU/SIEVE result cache:

```js
using transducer = liblevenshtein.transducer(dictionary);
using cache = liblevenshtein.queryCache(transducer, { maximumEntries: 512 });
using matches = cache.query("speling", 2, "distance-then-term");
console.log([...matches]);
```

The cache invalidates residency when the dictionary revision changes. Policy
approximation affects only which exact results remain resident, never result
correctness. Create one cache per Worker; cache objects are deliberately
exclusive and synchronization-free.

`size`, `set`, `get`, `has`, `delete`, `entries`, `keys`, `values`,
`forEach`, and `[Symbol.iterator]` mirror familiar collection behavior.
Ordinary iteration materializes one host-owned immutable revision, so early
loop exit leaks no native cursor. Large traversals use `streamEntries()`, a
bounded iterator with `nextBatch`, `reduceBatches`, `return`, `close`, and
`Symbol.dispose`.

## Snapshot algebra without JavaScript rebuilds

Union, intersection, left difference, and symmetric difference run inside the
shared native/WASM/WASI engine. Each call captures one immutable revision from
each same-domain input, linearly merges their ordered entries, and returns an
independently mutable DynamicDAWG. Duplicate values can keep the first or last
value or use the optional-`u64` lattice join or meet; union defaults to the last
value and intersection to lattice meet.

```js
using left = libdictenstein.dynamicDawg();
using right = libdictenstein.dynamicDawg();
left.set("shared", 4n);
right.set("shared", 9n);

using joined = left.union(right, "lattice-join");
using common = left.intersection(right);
console.log(joined.get("shared"), common.get("shared")); // 9n, 4n
```

The merge takes $`\Theta(|A|+|B|)`$ time and $`\Theta(|R|)`$ result storage. It
does not materialize a JavaScript `Map`, cross the host boundary per entry, or
publish a mutable graph once per key.

The same ownership rule applies to query cursors, phonetic patterns, rule sets,
builders, transducers, and WFSTs: prefer `using` or call `close()` in `finally`.
Garbage collection is exceptional-path containment, not resource scheduling.

## Backend contract

| Import | Backend | Intended host |
|---|---|---|
| `@vinary-tree/javascript-runtime` | Prebuilt N-API addon | Node services and tools |
| `@vinary-tree/javascript-runtime/wasm` | `wasm-bindgen` module | Browsers and web workers |
| `@vinary-tree/javascript-runtime/wasi` | Explicit WASI linear-memory ABI | Node with preopened persistent storage |

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

- [Complete JavaScript and TypeScript API reference](docs/api-reference.md)
- [Architecture and invariants](docs/architecture.md)
- [Testing strategy and property models](docs/testing.md)
- [Release order, platform matrix, and rollback](docs/releasing.md)
- [npm coordinate migration and compatibility](docs/npm-coordinate-migration.md)
- [History-preserving extraction provenance](docs/extraction-provenance.md)

Project-specific packages may present narrower idiomatic facades. This
repository owns and documents the complete shared native/WASM/WASI API they
consume, together with runtime identity, package assembly, and cross-project
integration tests.
