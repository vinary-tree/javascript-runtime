# npm coordinate migration for the JavaScript runtime

## Canonical public identity

The standalone runtime repository publishes
`@vinary-tree/javascript-runtime`. The name states what the package is and
matches the source repository; it is not a family-wide umbrella package. The
runtime hosts native N-API, browser WebAssembly (WASM), and WebAssembly System
Interface (WASI) backends for the project-specific facades.

RC4 was published under `@vinary-tree/vinary-tree`. That coordinate is an
immutable historical publication mistake. It does not rename the Vinary Tree
project, and it must not appear in new manifests, imports, examples, or release
graphs.

| Role | Coordinate | Policy from RC5 onward |
|---|---|---|
| Canonical shared runtime | `@vinary-tree/javascript-runtime` | Publish and consume directly. |
| Canonical resource contracts | `@vinary-tree/vinary-tree-interop` | Exact RC dependency of the runtime. |
| Legacy RC4 runtime | `@vinary-tree/vinary-tree` | Preserve immutable bytes; deprecate only after canonical public-install verification. |

## Single source of truth

[`release/version.json`](../release/version.json) owns
`coordinates.npmPackage`, the private property-test package name, the RC
version, and exact upstream versions and source tags. The synchronizer derives
package manifests from those fields and rejects legacy, malformed, or drifted
coordinates. In particular, it rejects an accidental concatenation such as
`@vinary-tree/javascript-runtime-interop`; the runtime and interop package are
two independent coordinates joined by an exact dependency edge.

## Safe migration algorithm

The following literate procedure distinguishes immutable artifacts from
mutable registry pointers:

```text
build native, WASM, and WASI artifacts from the exact RC5 source graph
pack the canonical runtime and inspect its package name and dependency keys
publish canonical RC5 with provenance under the `next` dist-tag
install from the public registry in an empty project
exercise all three backends and cross-project retained-resource handoff
promote canonical `latest` only after the full train passes
deprecate the legacy coordinate with a canonical replacement message
read back package metadata and dist-tags without local workspace overlays
```

If verification fails, leave the immutable version in place, keep or restore
the previous distribution tag, correct the source, and issue the next unused
candidate. Never overwrite a version or silently redirect module resolution.

## Consumer migration

Applications should normally install a project facade. Direct runtime users
replace both the package and any backend subpath:

```sh
npm install @vinary-tree/javascript-runtime@next
```

```js
import runtime from "@vinary-tree/javascript-runtime";
import wasmRuntime from "@vinary-tree/javascript-runtime/wasm";
import wasiRuntime from "@vinary-tree/javascript-runtime/wasi";
```

The runtime's public semantics do not change: one package instance owns the
runtime identity, and resources from another instance are rejected before
native dispatch.

## Trust boundary

The package is published through npm's repository-bound trusted publisher and
the protected `npm` environment. Public read-back must match the expected
repository, exact tag, version, coordinate, dependency coordinate, and
provenance before distribution tags or deprecations are changed. Authentication
material must never be written into package metadata, generated artifacts,
logs, or documentation.
