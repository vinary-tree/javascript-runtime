# Extraction provenance

This repository preserves the history of the former
`bindings/javascript-runtime` subtree from
[`vinary-tree/liblevenshtein-rust`](https://github.com/vinary-tree/liblevenshtein-rust).
The extraction used `git filter-repo`; it did not squash implementation
history.

| Identity | Commit |
|---|---|
| Source liblevenshtein commit | `7e6adac39aa82f2cb6339341f2dba36fd804772` |
| Filtered runtime commit | `838a2a8b25a18d8de7e096270585eecbd8eed369` |

The Apache-2.0 license was then added from the source repository root. The
first standalone decomposition commit introduces only repository ownership,
portable dependency staging, release automation, and documentation changes on
top of the filtered history.
