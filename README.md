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

## Compose custom JavaScript automata

JavaScript and TypeScript objects can implement immutable scalar WFSTs without
copying the complete graph into Rust. This example declares a one-transition
transducer; `null` labels denote epsilon and state IDs remain exact `bigint`
values:

```js
const provider = {
  startState: () => 0n,
  stateCount: () => 2n,
  stateInfo: (state) => ({
    valid: state === 0n || state === 1n,
    final: state === 1n,
    finalWeight: 0,
  }),
  stateArcs: (state) => state === 0n
    ? [{ input: "a", output: "A", target: 1n, weight: 0 }]
    : [],
};

using uppercaseA = llingLlang.scalarWfst(provider, { acyclic: true });
using product = llingLlang.compose(existingWfst, uppercaseA);
```

The same provider contract runs on the native, browser-WebAssembly, and WASI
entrypoints. High-degree states can implement `stateArcsPage` to return bounded
pages. Every backend roots the provider through the last retained composition,
contains exceptions as provider errors, rejects reentrant callbacks without
blocking, and validates all state and arc records before publishing them. See
the [complete provider guide](https://github.com/vinary-tree/vinary-tree-interop/blob/master/docs/language-bindings/javascript-host-providers.md).

## Compute with custom JavaScript lattices

Every backend can root immutable JavaScript or TypeScript values behind
lling-llang's dynamic lattice interface. A stable 16-byte domain ID prevents
accidental operations between unrelated algebras:

```js
class Maximum {
  constructor(value) { this.value = value; }
  join(other) { return new Maximum(Math.max(this.value, other.localValue.value)); }
  meet(other) { return new Maximum(Math.min(this.value, other.localValue.value)); }
  equal(other) { return this.value === other.localValue.value; }
  diagnostic() { return `maximum(${this.value})`; }
}

using first = llingLlang.lattice(new Maximum(3), {
  domainId: "example.maximum1",
});
using second = llingLlang.lattice(new Maximum(8), {
  domainId: "example.maximum1",
});
using maximum = first.join(second);
console.log(maximum.diagnostic()); // maximum(8)
```

Optional paired `joinMany` and `meetMany` callbacks enable bounded bulk folds;
results may renegotiate that capability and automatically continue pairwise.
`validateLatticeLaws` probes idempotence, commutativity, associativity, and
absorption over representative values. The adapter holds no mutex while host
code runs, rejects recursive entry without blocking, copies foreign stable
bytes eagerly, and retains every result independently. Browser WebAssembly and
WASI use the same contract through runtime-native generational handle tables;
native Node uses the lower-overhead N-API resource path.

## Run custom JavaScript semirings

Every backend can execute a host-defined semiring: `plus` combines alternative
paths, while `times` extends one path with another segment. The adapter roots
ordinary immutable JavaScript values behind provider-scoped, generation-checked
tokens, so values do not need a native representation:

```js
const probability = {
  zero: () => 0,
  one: () => 1,
  plus: (left, right) => left + right,
  times: (left, right) => left * right,
  equal: Object.is,
  approximatelyEqual: (left, right, epsilon) => Math.abs(left - right) <= epsilon,
  naturalOrder: (left, right) => left > right ? "better" : left < right ? "worse" : "equal",
  diagnostic: (value) => value === undefined ? "probability" : `p=${value}`,
  numericalValue: (value) => value,
  quantize: (value, epsilon) => BigInt(Math.round(value / epsilon)),
  toProbability: (value) => value,
};

using weights = llingLlang.semiring(probability, {
  domainId: "demo.probability",
  properties: ["commutative-times", "totally-ordered", "nonnegative"],
});
using zero = weights.zero();
using one = weights.one();
using two = weights.plus(one, one);
console.log(two.diagnostic()); // p=2
```

Optional batch, division, closure, stable-byte, numerical, and law capabilities
are negotiated independently. Operations reject weights from another operation
context even when the two contexts declare the same domain. Native Node,
browser WebAssembly, and WASI expose the same surface, contain provider
exceptions, reject recursive entry without blocking, and release every rooted
value deterministically through `close()` or `Symbol.dispose`.

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
