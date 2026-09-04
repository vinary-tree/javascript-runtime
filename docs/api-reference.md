# JavaScript and TypeScript API reference

This is the complete public reference for `@vinary-tree/javascript-runtime`
4.0.0-rc.6. The package loads one native N-API, browser WebAssembly, or Node
WASI runtime and exposes four project namespaces over its single resource
table. Project facades may narrow this surface, but they use the same objects,
ownership rules, and runtime identity.

For architectural rationale, trust boundaries, and the one-runtime invariant,
read the [architecture guide](architecture.md). For a first installation, start
with the [package README](../README.md).

## Terms

| Term | Meaning |
|---|---|
| runtime | One initialized native, WebAssembly, or WASI implementation with one allocator and one resource table. |
| runtime identity | The frozen `runtimeIdentity` object stamped on resources. Identity is compared by object identity, not by its printable fields. |
| resource | A closeable dictionary or weighted finite-state transducer (WFST) backed by the selected runtime. |
| snapshot | The immutable dictionary revision captured when an iterator, stream, or query begins. Later mutations publish another revision and do not alter existing traversal. |
| unit domain | The dictionary key alphabet: Unicode scalar values (`"unicode"`), bytes (`"byte"`), or unsigned 64-bit tokens (`"u64"`). |
| value domain | Optional unsigned 64-bit identifiers represented as `bigint | null`; `undefined` is reserved for a missing key. |
| lease | A bounded batch temporarily owned by a cursor. JavaScript receives host-owned values; the runtime settles the underlying native lease before returning. |

## Installation and runtime selection

```sh
npm install @vinary-tree/javascript-runtime@next
```

| Import | Runtime | Intended use |
|---|---|---|
| `@vinary-tree/javascript-runtime` | Native N-API addon | Node services, command-line tools, and maximum throughput. |
| `@vinary-tree/javascript-runtime/wasm` | Browser WebAssembly | Browsers and Web Workers without persistent dictionaries. |
| `@vinary-tree/javascript-runtime/wasi` | WASI Preview 1 | Node applications that explicitly preopen persistent-storage paths. |

The root and browser imports export `runtimeIdentity`, `libdictenstein`,
`liblevenshtein`, `llingLlang`, and `duallity`, plus the same object as the
default export. The WASI module exports those names after initialization and
also exports `createWasiRuntime` for an isolated configured instance.

Never mix resources from two package instances or runtime paths. A resource
created by one `runtimeIdentity` is rejected by another before native dispatch.

## Common usage

### Dictionary and fuzzy query

```js
import { libdictenstein, liblevenshtein } from "@vinary-tree/javascript-runtime";

using dictionary = libdictenstein.dynamicDawg("unicode");
dictionary.set("cat", 1n).set("cot", 2n).set("cut", null);

const transducer = liblevenshtein.transducer(dictionary, "standard");
try {
  using cursor = transducer.query("cat", 1, "distance-then-term");
  for (const match of cursor) {
    console.log(match.term.value, match.distance, match.id);
  }
} finally {
  transducer.close();
}
```

### Bounded reduction

Use a cursor reducer when the output can be large. `reduceBatches` closes the
cursor in a `finally` block even if the reducer throws.

```js
using cursor = transducer.query("catalogue", 2);
const histogram = cursor.reduceBatches(
  (counts, batch) => {
    for (const { distance } of batch) {
      counts.set(distance, (counts.get(distance) ?? 0) + 1);
    }
    return counts;
  },
  new Map(),
  256,
);
```

### Compose a dictionary-derived query with another WFST

`duallity.wfst` turns a dictionary query into a lazy WFST. `llingLlang.compose`
forms the product with another same-runtime WFST without serializing either
resource.

```js
import {
  duallity,
  libdictenstein,
  llingLlang,
} from "@vinary-tree/javascript-runtime";

using dictionary = libdictenstein.dynamicDawg();
dictionary.set("color", 1n).set("colour", 2n);

const query = duallity.wfst(dictionary, "colur", 1, "standard", "levenshtein");
try {
  const constraint = llingLlang.vectorWfst();
  try {
    const states = Array.from({ length: 6 }, () => constraint.addState());
    constraint.setStart(states[0]);
    constraint.setFinal(states[5], 0);
    for (const [index, label] of [..."color"].entries()) {
      constraint.addArc(states[index], label, label, states[index + 1], 0);
    }
    const acceptor = constraint.build();
    try {
      const product = llingLlang.compose(query, acceptor);
      try {
        console.log(product.state(product.start()));
      } finally {
        product.close();
      }
    } finally {
      acceptor.close();
    }
  } finally {
    constraint.close();
  }
} finally {
  query.close();
}
```

## Type model

### Dictionary and match values

| Type | Definition and invariants |
|---|---|
| `DictionaryValue` | `bigint | null`. `null` is a present key with no identifier. |
| `DictionaryKey` | `string | Uint8Array | BigUint64Array`; the value must match the dictionary unit domain. |
| `DictionaryEntry` | Frozen pair `readonly [DictionaryKey, DictionaryValue]`. |
| `AlgebraOperation` | `"union" | "intersection" | "difference" | "symmetric-difference"`. |
| `ValueMerge` | `"first" | "last" | "lattice-join" | "lattice-meet"` for overlapping optional values. |
| `Lookup` | `{ found: boolean, value: DictionaryValue }`; inspect `found` to distinguish absence from a present `null`. |
| `Term` | Tagged union carrying `{ domain, value }` for Unicode, byte, or `u64` query output. |
| `Match` | `{ term: Term, distance: number, id: bigint | null }`. |
| `AutomatonSize` | `{ states: number, transitions: number }` for a compiled phonetic pattern. |

The fields `Lookup.found`, `Lookup.value`, `Term.domain`, `Term.value`,
`Match.term`, `Match.distance`, `Match.id`, `AutomatonSize.states`, and
`AutomatonSize.transitions` are readonly host values.

### Algorithms and ordering

`Algorithm` accepts:

| Value | Semantics |
|---|---|
| `"standard"` | Levenshtein insertion, deletion, and substitution. |
| `"transposition"` | Optimal string alignment (restricted adjacent transposition). |
| `"merge-and-split"` | Standard edits plus adjacent merge and split operations. |
| `"damerau-levenshtein"` | Unrestricted Damerau–Levenshtein distance. |

`QueryOrder` accepts `"traversal"` for backend traversal order or
`"distance-then-term"` for increasing distance with a deterministic term
tiebreaker. Byte- and `u64`-domain queries currently use traversal order.

## Dictionary API

The `LibdictensteinNamespace` value is exported as `libdictenstein`.
`libdictenstein.runtimeIdentity` is the identity that all returned resources
carry.

### Constructors

| API | Result |
|---|---|
| `libdictenstein.dynamicDawg(unitDomain?)` | Mutable dynamic directed acyclic word graph. Defaults to `"unicode"`. |
| `libdictenstein.doubleArrayTrie(entries, unitDomain?)` | Compact read-mostly double-array trie built from Unicode or byte entries. |
| `libdictenstein.scdawg(unitDomain?)` | Mutable suffix-oriented compact DAWG with substring queries. |

### `Dictionary`

| API | Semantics |
|---|---|
| `Dictionary.size` | Number of keys in the current published revision. |
| `Dictionary.put(term, value?)` | Insert or replace a key; returns whether the dictionary changed. The default value is `null`. |
| `Dictionary.putU64(term, value?)` | Explicit `BigUint64Array` insertion. |
| `Dictionary.set(term, value?)` | Map-style insertion returning the same dictionary for chaining. |
| `Dictionary.remove(term)` / `Dictionary.removeU64(term)` | Remove a key and return whether it existed. |
| `Dictionary.delete(term)` | Map-style alias for `remove`. |
| `Dictionary.lookup(term)` / `Dictionary.lookupU64(term)` | Return an unambiguous `Lookup`. |
| `Dictionary.get(term)` / `Dictionary.getU64(term)` | Return `bigint`, `null`, or `undefined` when absent. |
| `Dictionary.has(term)` / `Dictionary.hasU64(term)` | Membership test. |
| `Dictionary.snapshotEntries()` | Frozen array of frozen entries from one immutable revision. |
| `Dictionary.entries()` / `Dictionary.keys()` / `Dictionary.values()` | Host-owned snapshot iterators; early loop exit owns no native cursor. |
| `Dictionary[Symbol.iterator]()` | Same as `entries()`. |
| `Dictionary.streamEntries()` | Closeable bounded `DictionaryEntryCursor` for large results. |
| `Dictionary.algebra(right, operation, valueMerge?)` | Capture one revision of each same-domain input and materialize the selected native set operation as an independent mutable DynamicDAWG. |
| `Dictionary.union(right, valueMerge?)` | Materialized union; shared values default to `"last"`. |
| `Dictionary.intersection(right, valueMerge?)` | Materialized intersection; shared values default to `"lattice-meet"`. |
| `Dictionary.difference(right)` | Materialize keys present only in the receiver. |
| `Dictionary.symmetricDifference(right)` | Materialize keys present in exactly one input. |
| `Dictionary.forEach(callback, thisArg?)` | Map-compatible callback order `(value, key, dictionary)`. |
| `Dictionary.toMap()` | Copy a Unicode dictionary into a standard `Map`; byte and `u64` keys are rejected because JavaScript typed arrays use reference identity. |
| `Dictionary.clear()` | Publish an empty revision. |
| `Dictionary.compact()` | Compact supported mutable storage and return the implementation-defined reclaimed count. |
| `Dictionary.containsSubstring(term)` | SCDAWG substring membership. Unsupported backends throw. |
| `Dictionary.substringFrequency(term)` | SCDAWG substring occurrence count. Unsupported backends throw. |
| `Dictionary.close()` / `Dictionary[Symbol.dispose]()` | Idempotently release the native resource. |

### `DictionaryEntryCursor`

`DictionaryEntryCursor` is an `IterableIterator<DictionaryEntry>`.

| API | Semantics |
|---|---|
| `DictionaryEntryCursor.size` | Number of entries captured by the cursor. |
| `DictionaryEntryCursor.identity` | Snapshot identity when a backend exposes it; currently `null` on the JavaScript runtime paths. |
| `DictionaryEntryCursor.next()` | Return the next entry and close automatically at exhaustion. |
| `DictionaryEntryCursor.nextBatch(maximum)` | Return at most `maximum` entries; `maximum` must be a positive safe integer. |
| `DictionaryEntryCursor.reduceBatches(reducer, initial, batchSize?)` | Fold bounded batches; defaults to 256 and always closes. |
| `DictionaryEntryCursor.return()` | Close on early iterator termination. |
| `DictionaryEntryCursor.close()` / `DictionaryEntryCursor[Symbol.dispose]()` | Idempotently release the snapshot/cursor. |

## Liblevenshtein API

The `LiblevenshteinNamespace` value is exported as `liblevenshtein`.
`liblevenshtein.runtimeIdentity` identifies resources accepted by its
constructors.

### Scalar distance functions

| API | Result |
|---|---|
| `liblevenshtein.levenshteinDistance(source, target)` | Exact standard Levenshtein distance. |
| `liblevenshtein.levenshteinDistanceThreshold(source, target, maximum)` | Distance when it is at most `maximum`; otherwise `undefined`. |
| `liblevenshtein.damerauDistance(source, target)` | Exact optimal-string-alignment distance. |
| `liblevenshtein.damerauDistanceThreshold(source, target, maximum)` | Thresholded optimal-string-alignment distance. |
| `liblevenshtein.trueDamerauDistance(source, target)` | Exact unrestricted Damerau–Levenshtein distance. |
| `liblevenshtein.trueDamerauDistanceThreshold(source, target, maximum)` | Thresholded unrestricted Damerau–Levenshtein distance. |

Threshold functions return a number when the true distance equals the bound.
They return `undefined` only when the distance exceeds it.

### Transducers and queries

| API | Semantics |
|---|---|
| `liblevenshtein.transducer(dictionary, algorithm?)` | Validate same-runtime dictionary identity, retain it, and construct a `Transducer`. Defaults to `"standard"`. |
| `Transducer.query(input, maximumDistance, order?)` | Capture one query-start snapshot and return a `QueryCursor`. Strings accept `QueryOrder`; typed arrays and patterns use traversal order. |
| `Transducer.close()` / `Transducer[Symbol.dispose]()` | Release the transducer's dictionary retain. Existing cursors remain valid because each owns its snapshot. |

`Transducer.query` accepts `string`, `Uint8Array`, `BigUint64Array`, or a
same-runtime `PhoneticPattern`. A type/domain mismatch throws instead of
coercing data or silently changing semantics.

`QueryCursor` is an `IterableIterator<Match>`:

| API | Semantics |
|---|---|
| `QueryCursor.next()` | Return one host-owned `Match`; close automatically at exhaustion. |
| `QueryCursor.nextBatch(maximum)` | Return at most `maximum` matches and settle the native batch lease before returning. |
| `QueryCursor.reduceBatches(reducer, initial, batchSize?)` | Fold bounded batches, default 256, and close in `finally`. |
| `QueryCursor.return()` | Close when `for...of` terminates early. |
| `QueryCursor.close()` / `QueryCursor[Symbol.dispose]()` | Idempotently release the captured snapshot and cursor arenas. |

### Bounded query cache

`liblevenshtein.queryCache(transducer, options?)` retains the transducer and
creates an exclusive `QueryCache`. `QueryCacheOptions.maximumEntries` defaults
to 1,024 and `QueryCacheOptions.maximumWeight` defaults to 64 MiB; both are hard
bounds applied independently to traversal-order and distance-then-term shards.
A zero bound disables admission while preserving exact query results.

| API | Semantics |
|---|---|
| `liblevenshtein.queryCache(transducer, options?)` | Create a bounded complete-result cache over a same-runtime `Transducer`. |
| `QueryCache.query(input, maximumDistance, order?)` | Return an independent `QueryCursor` over an exact cached or freshly computed result. Strings accept `QueryOrder`; `Uint8Array` and `BigUint64Array` inputs use traversal order. |
| `QueryCache.stats` | Return immutable `QueryCacheStats`: `requests`, `hits`, `misses`, `admissions`, `rejections`, `evictions`, `residentEntries`, and `residentWeight`. |
| `QueryCache.clear()` | Drop resident results, retain source ownership and counters, and return the cache for chaining. |
| `QueryCache.resetStats()` | Reset counters, retain residency/frequency state, and return the cache for chaining. |
| `QueryCache.close()` / `QueryCache[Symbol.dispose]()` | Idempotently release resident results and the retained transducer. Existing cursors remain valid. |

| Statistic | Meaning |
|---|---|
| `QueryCacheStats.requests` | Total cache queries. |
| `QueryCacheStats.hits` | Queries served from resident immutable results. |
| `QueryCacheStats.misses` | Queries that executed the exact product walk. |
| `QueryCacheStats.admissions` | Computed results admitted by the bounded policy. |
| `QueryCacheStats.rejections` | Exact results returned but not retained. |
| `QueryCacheStats.evictions` | Resident results displaced by SIEVE. |
| `QueryCacheStats.residentEntries` | Current entries across both order shards. |
| `QueryCacheStats.residentWeight` | Current logical byte weight across both shards. |

TinyLFU estimates which results are worth admitting; SIEVE selects a resident
entry when space must be reclaimed. Both policies affect residency only. Cache
misses always execute the exact query, and dictionary snapshot identity clears
stale residency before a changed revision can be observed. A cache is
synchronization-free and single-owner: use one cache per Worker rather than
sharing one mutable cache across concurrent callers.

```js
const transducer = liblevenshtein.transducer(dictionary);
using cache = liblevenshtein.queryCache(transducer, {
  maximumEntries: 512,
  maximumWeight: 32 * 1024 * 1024,
});
try {
  using cursor = cache.query("speling", 2, "distance-then-term");
  console.log([...cursor]);
  console.log(cache.stats.hits);
} finally {
  transducer.close();
}
```

### Phonetic patterns and rules

| API | Semantics |
|---|---|
| `liblevenshtein.phoneticPattern(source)` | Compile the phonetic regular-expression syntax into a `PhoneticPattern`. |
| `liblevenshtein.llrePattern(source)` | Compile the `.llre` language into a `PhoneticPattern`. |
| `PhoneticPattern.size` | `AutomatonSize` of the compiled pattern. |
| `PhoneticPattern.matches(input)` | Test full-pattern acceptance. |
| `PhoneticPattern.close()` | Release compiled automaton storage. |
| `liblevenshtein.phoneticRules(source)` | Compile a rule program or select a built-in ruleset name such as `"english-orthography"`. |
| `PhoneticRuleSet.size` | Number of compiled rules. |
| `PhoneticRuleSet.apply(input)` | Return a host-owned transformed string. |
| `PhoneticRuleSet.close()` | Release compiled rule storage. |

Phonetic features can be absent from a build. In that case construction throws
an `Error` carrying the native unsupported-status message; there is no partial
pattern object to close.

### Native-operation traceability

The JavaScript facade deliberately absorbs native allocation and release
functions into object methods. This table names every exposed liblevenshtein
mapping so the facade, native ABI, tests, and documentation remain auditable.

| Native operation | JavaScript symbol |
|---|---|
| `llev_distance` | `liblevenshtein.levenshteinDistance` |
| `llev_distance_threshold` | `liblevenshtein.levenshteinDistanceThreshold` |
| `llev_damerau_distance` | `liblevenshtein.damerauDistance` |
| `llev_damerau_distance_threshold` | `liblevenshtein.damerauDistanceThreshold` |
| `llev_true_damerau_distance` | `liblevenshtein.trueDamerauDistance` |
| `llev_true_damerau_distance_threshold` | `liblevenshtein.trueDamerauDistanceThreshold` |
| `llev_transducer_new` | `liblevenshtein.transducer` |
| `llev_transducer_free` | `Transducer.close` |
| `llev_query_cache_new` | `liblevenshtein.queryCache` |
| `llev_query_cache_clear` | `QueryCache.clear` |
| `llev_query_cache_reset_stats` | `QueryCache.resetStats` |
| `llev_query_cache_stats` | `QueryCache.stats` |
| `llev_query_cache_free` | `QueryCache.close` |
| `llev_query_cache_query_utf8` / `llev_query_cache_query_bytes` / `llev_query_cache_query_u64` | `QueryCache.query` |
| `llev_transducer_query_utf8` / `llev_transducer_query_bytes` / `llev_transducer_query_u64` / `llev_transducer_query_pattern` | `Transducer.query` |
| `llev_query_cursor_next_batch` | `QueryCursor.nextBatch` |
| `llev_query_cursor_release_batch` | `QueryCursor.nextBatch` settles the lease before returning. |
| iterator protocol | `QueryCursor.next` |
| reducer protocol | `QueryCursor.reduceBatches` |
| `llev_query_cursor_free` | `QueryCursor.close` |
| `llev_phonetic_pattern_compile_regex` | `liblevenshtein.phoneticPattern` |
| `llev_phonetic_pattern_compile_llre` | `liblevenshtein.llrePattern` |
| `llev_phonetic_pattern_free` | `PhoneticPattern.close` |
| `llev_phonetic_pattern_size` | `PhoneticPattern.size` |
| `llev_phonetic_pattern_matches` | `PhoneticPattern.matches` |
| `llev_phonetic_rules_parse` / `llev_phonetic_rules_builtin` | `liblevenshtein.phoneticRules` |
| `llev_phonetic_rules_free` | `PhoneticRuleSet.close` |
| `llev_phonetic_rules_len` | `PhoneticRuleSet.size` |
| `llev_phonetic_rules_apply` / `llev_owned_string_free` | `PhoneticRuleSet.apply` returns a host-owned string. |
| algorithm enum | `Algorithm` |
| query-order enum | `QueryOrder` |

## WFST APIs

### Shared WFST types

`WeightDomain` accepts `"tropical-f64"`, `"log-f64"`,
`"probability-f64"`, `"arctic-f64"`, `"signed-tropical-f64"`,
`"count-f64"`, or `"boolean-f64"`.

| Type/member | Meaning |
|---|---|
| `WfstArc.input` / `WfstArc.output` | `number` for bytes, `string` for Unicode scalars, `bigint` for u64 tokens, or `null` for epsilon. |
| `WfstArc.target` | Target state identifier as `bigint`. |
| `WfstArc.weight` | Weight in the WFST's `WeightDomain`. |
| `WfstState.valid` | Whether the requested state exists. |
| `WfstState.final` / `WfstState.finalWeight` | Final-state flag and weight. |
| `WfstState.arcs` | Immutable outgoing `WfstArc` list. |
| `Wfst.interfaceId` | Always `"vt.scalar-wfst.1"`. |
| `Wfst.runtimeIdentity` | Identity of the owning runtime. |
| `Wfst.unitDomain` | `"byte"`, `"unicode"`, or `"u64"`; determines the arc-label type. |
| `Wfst.weightDomain` | Semiring/weight domain used by the resource. |
| `Wfst.start()` | Start-state identifier. |
| `Wfst.state(state)` | Inspect one state without materializing the whole graph. |
| `Wfst.close()` | Release the retained WFST resource. |
| `Wfst[Symbol.dispose]()` | Idempotently release the retained WFST resource. |

### lling-llang

The `LlingLlangNamespace` value is exported as `llingLlang`.

| API | Semantics |
|---|---|
| `llingLlang.runtimeIdentity` | Identity required for input WFSTs. |
| `llingLlang.vectorWfst()` | Create a mutable `WfstBuilder`. |
| `llingLlang.lattice(provider, options)` | Root one immutable JavaScript/TypeScript `LatticeProvider` as a closeable native `Lattice`. |
| `llingLlang.validateLatticeLaws(values)` | Try to falsify the lattice laws over one to sixteen same-domain representative values. |
| `llingLlang.scalarWfst(provider, options?)` | Root a JavaScript/TypeScript `ScalarWfstProvider` as an immutable closeable WFST. |
| `llingLlang.compose(first, second)` | Lazily compose two same-runtime `Wfst` resources. |
| `WfstBuilder.addState()` | Add a state and return its numeric builder-local identifier. |
| `WfstBuilder.setStart(state)` | Select the start state. |
| `WfstBuilder.setFinal(state, weight)` | Mark a state final with a weight. |
| `WfstBuilder.addArc(from, input, output, to, weight)` | Add a Unicode or epsilon arc. |
| `WfstBuilder.build()` | Freeze the builder into a closeable `Wfst`. |
| `WfstBuilder.close()` | Release unfinished builder storage. |
| `WfstBuilder[Symbol.dispose]()` | Idempotently release unfinished builder storage. |

### Host-defined scalar WFSTs

`ScalarWfstProvider` requires `startState`, `stateCount`, `stateInfo`, and
`stateArcs`. It may add `stateArcsPage(state, start, capacity)` to avoid
materializing every outgoing arc at once. `ScalarWfstProviderOptions` selects
the unit domain, weight domain, laziness claim, and acyclicity claim. Defaults
are Unicode labels, tropical-f64 weights, lazy expansion, and no acyclicity
claim.

All state IDs, arc targets, page offsets, page totals, and known state counts
are unsigned 64-bit `bigint` values. Byte labels are integers from 0 through
255; Unicode labels are one-scalar strings; u64 labels are unsigned 64-bit
`bigint`; and `null` is epsilon. Weights are JavaScript numbers other than NaN.

Construction validates the method surface and options. Each callback validates
its complete result before the runtime changes caller-visible output. Pages
must stay within `capacity`, make progress, and report one stable total for an
expansion. Closing the source is safe after a composition captures it because
the product owns an independent retain.

The runtime-specific ownership and error model is documented in the
[JavaScript host-provider guide](https://github.com/vinary-tree/vinary-tree-interop/blob/master/docs/language-bindings/javascript-host-providers.md).

### Host-defined lattice values

`LatticeProvider` lets JavaScript or TypeScript supply immutable values for an
application-specific lattice. `LatticeProviderOptions.domainId` is a printable
16-byte `ProviderDomainId`; operations reject a `LatticeResource` from another
runtime or domain before invoking foreign code. Each `LatticeOperand` contains
that domain ID, an eager `localValue` for values owned by this JavaScript
runtime, and copied `stableBytes` for compatible foreign resources when they
are available. It contains no borrowed pointer or buffer.

```js
class Maximum {
  constructor(value) { this.value = value; }
  join(other) { return new Maximum(Math.max(this.value, other.localValue.value)); }
  meet(other) { return new Maximum(Math.min(this.value, other.localValue.value)); }
  equal(other) { return this.value === other.localValue.value; }
  diagnostic() { return `maximum(${this.value})`; }
}

using low = llingLlang.lattice(
  new Maximum(3),
  { domainId: "example.maximum1" },
);
using high = llingLlang.lattice(
  new Maximum(8),
  { domainId: "example.maximum1" },
);
using upperBound = low.join(high);
console.log(upperBound.diagnostic()); // maximum(8)
```

`Lattice.interfaceId` is always `"vt.lattice.val.1"`;
`Lattice.runtimeIdentity` and `Lattice.domainId` identify compatible operands.
`Lattice.join` and `Lattice.meet` compute binary bounds, while
`Lattice.equal` asks the provider for semantic equality. `Lattice.joinMany`
and `Lattice.meetMany` use provider batches of at most 256 operands when the
current value advertises both optional batch methods, then automatically fall
back to pairwise calls if a result renegotiates that capability.

`Lattice.stableBytes` returns copied deterministic identity bytes when the
provider implements the optional method. `Lattice.diagnostic` returns bounded
human-readable text. `Lattice.close` and `Lattice[Symbol.dispose]` release the
native retain idempotently. Callback exceptions become provider errors;
recursive entry fails immediately through an atomic gate instead of blocking.
The current executable lattice trampoline is available on the native N-API
entrypoint. Browser WebAssembly and WASI lattice trampolines remain follow-up
work; the scalar-WFST provider is already available on all three backends.

### duallity

The `DuallityNamespace` value is exported as `duallity`.
`DuallityWfstKind` accepts `"levenshtein"`, the three `"universal-*"`
variants, the four `"generalized-*"` variants, or `"fzf"`.

`duallity.runtimeIdentity` identifies accepted dictionaries.
`duallity.wfst(dictionary, query, maximumDistance, algorithm?, kind?)` captures
one dictionary snapshot and creates a closeable lazy `Wfst`. It defaults to the
standard algorithm and `"levenshtein"` kind.

## WASI API

Import from `@vinary-tree/javascript-runtime/wasi`.

`WasiRuntimeOptions.preopens` maps guest paths to host paths. No path outside
that capability map is visible to the runtime. `WasiRuntimeOptions.wasm` may
supply a URL or precompiled `WebAssembly.Module`.

`createWasiRuntime(options?)` returns `Promise<WasiRuntime>`. `WasiRuntime`
contains `WasiRuntime.runtimeIdentity`, `WasiRuntime.libdictenstein`,
`WasiRuntime.liblevenshtein`, `WasiRuntime.llingLlang`, and
`WasiRuntime.duallity`, all tied to that isolated instance.

The WASI dictionary namespace adds
`WasiRuntime.libdictenstein.createPersistentARTrie(path, unitDomain?)` and
`WasiRuntime.libdictenstein.openPersistentARTrie(path, unitDomain?)`.
`PersistentDictionary` extends `Dictionary` with
`PersistentDictionary.checkpoint()`, which explicitly commits a durable
checkpoint at a preopened path. The WASI liblevenshtein namespace exposes
`WasiRuntime.liblevenshtein.transducer`; its returned transducer has the same
query-start snapshot and close semantics described above.
`WasiRuntime.liblevenshtein.queryCache` accepts that transducer and exposes the
same UTF-8, byte, and u64 cache, statistics, invalidation, and lifecycle
contract. Provider work executes while the exclusive cache handle is outside
the WASI resource table, so a callback never runs under the table lock and
reentrant use fails diagnostically.

`WasiRuntime.llingLlang.scalarWfst` stores each provider in an
index-plus-generation host table and transfers one retain to the guest. Guest
callbacks carry only the generational handle, state IDs, and bounded
linear-memory buffers; raw Rust or JavaScript pointers never cross the
boundary. Closing the last guest snapshot releases the table slot and advances
its generation before reuse.

## Lifecycle and ownership

Every resource type that declares `close()` owns native or WebAssembly state.
`Dictionary`, `DictionaryEntryCursor`, `QueryCursor`, `QueryCache`, `Wfst`,
`WfstBuilder`, and `Lattice` also implement
`Symbol.dispose`, so they support explicit resource management:

```js
using dictionary = libdictenstein.dynamicDawg();
const transducer = liblevenshtein.transducer(dictionary);
try {
  using cursor = transducer.query("cat", 1);
  // Consume cursor here.
} finally {
  transducer.close();
}
```

Use `close()` from `finally` for transducers, phonetic resources, and
environments without `using`. Every `close()` is idempotent, as
is `[Symbol.dispose]()` where declared. Iterator exhaustion and iterator
`return()` close cursors automatically, but an abandoned cursor that is neither
exhausted nor closed remains live until exceptional-path garbage-collection
cleanup.

Closing a dictionary does not invalidate a transducer that already retained it.
Closing a transducer does not invalidate an existing query cursor: the cursor
owns the immutable snapshot captured at query start.
Closing a transducer or source dictionary also does not invalidate a live
`QueryCache`, because the cache retained its own transducer reference.

## Errors

| JavaScript error | Cause |
|---|---|
| `TypeError` | Wrong key/input type, unit-domain mismatch, wrong interface, cross-runtime resource, or `toMap()` on typed-array keys. |
| `RangeError` | A batch size or numeric bound is outside its documented safe-integer domain. Cache limits may be zero; batch sizes and query bounds follow their operation contracts. |
| `Error` | Native status failure, closed resource, unsupported feature, I/O failure, provider failure, or contained Rust panic. The message carries the bounded native error text. |
| WebAssembly trap | A failure below status containment. It terminates that instance, not the host process; discard the instance and its resources. |

No Rust panic or C++ exception is permitted to unwind across the package
boundary. Failed constructors return no partially owned resource.

## Concurrency and snapshots

JavaScript wrappers are synchronous objects associated with one runtime
instance. Do not transfer them between Workers; initialize one runtime per
Worker and exchange serialized application data instead. Native internals may
serve concurrent hosts, but JavaScript object access still follows the host's
ordinary run-to-completion rules.

Dictionary mutation publishes a new immutable revision. `snapshotEntries`,
collection iterators, entry cursors, transducer queries, and dictionary-derived
WFSTs each remain pinned to the revision captured at their start. No traversal
holds a writer lock, and no later mutation changes already yielded or pending
results.

`QueryCache` is intentionally exclusive and synchronization-free. Native and
browser callers keep one cache in one JavaScript agent. The WASI adapter removes
the cache from its handle table during provider execution, so callbacks run
without a table mutex and recursive use of the same cache is rejected.

## Performance

- Scalar distance functions cross the boundary once per call.
- Dictionary/query iteration batches native results; the default reducer batch
  size is 256. Increase it to reduce boundary crossings when records are small,
  or decrease it to reduce peak host memory for large terms.
- `entries`, `keys`, `values`, and `snapshotEntries` materialize the full output
  in host memory. Use `streamEntries` for large dictionaries.
- Dictionary algebra merges two captured lexicographic streams in
  $`\Theta(|A|+|B|)`$ time, bulk-builds the mutable result once, and avoids a
  JavaScript `Map` or per-entry host calls.
- `QueryCursor.next()` internally amortizes traversal through native batching;
  `nextBatch` and `reduceBatches` make the batching explicit.
- `QueryCache` avoids repeated automaton/dictionary walks for hot queries. Hits
  still construct an independent cursor and copy requested values into the host;
  benchmark cold misses, hot hits, admission rejection, and revision
  invalidation separately.
- Same-runtime dictionaries and WFSTs cross project boundaries as retained
  resources. They are not serialized or copied.
- `llingLlang.compose` and `duallity.wfst` preserve lazy product/state
  construction; inspect only the states demanded by the consumer.

## Security and compatibility

The runtime validates `interfaceId` and `runtimeIdentity` before accepting a
dictionary or WFST. WASI exposes only explicit preopens. Browser WebAssembly
ships no persistence promise. Native N-API prebuilds are selected by supported
platform/architecture identity and embed all core static components, so users
configure no shared-library search path.

The TypeScript declarations in [`index.d.ts`](../index.d.ts) and
[`wasi.d.ts`](../wasi.d.ts) are normative for syntax. This reference is
source-checked against every exported declaration and behavioral interface
member by `scripts/check-docs.mjs`. A release may add compatible methods, but it
must document them in the same immutable candidate before publication.
