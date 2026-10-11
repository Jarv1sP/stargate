# Dataset subsets: phase 1 protocol and node views

This first change supplies protocol helpers and a private cache-view copier. It
does **not** advertise node subset support, register new RPC routes, change the
CLI, or install node code. Transfer/training integration and the CLI/storage UI
follow in separate changes. Whole-version cache and warehouse behavior is unchanged.

`dataset-subsets.mjs` and `deploy/dataset-subset.py` implement the same
`dataset-subset-v1` identity. Resolve against the authenticated full fixed-version
manifest, verify its SHA, normalize include/exclude/exact paths independently,
then hash the selected `[path,size,sha256]` list. The selection ID binds the parent
version, normalized rules and selected list SHA. It is not an authorization token
and remains distinct even if every file was explicitly selected.

Paths are UTF-8, case sensitive and relative. No Unicode or case normalization
occurs. `*`, `?`, and character classes match one component; a whole-component
`**` matches zero or more components. Include and exact paths form a union, then
exclude applies. An empty files-from, unknown exact path or empty result is an
error. Only an ordinary request with no selection parameters uses the existing
whole-version flow.

Limits: **64 include/exclude rules combined**, before deduplication; 1024 UTF-8
bytes per rule; files-from at most 100000 lines and 8 MiB, including line endings;
4096 bytes per exact path. A normalized selection is at most 16 MiB; selected
files and required parent directories retain the 500000-entry / 64 MiB manifest
limits. Numeric byte counts must be safe JS integers. The future CLI must read
files-from with a bounded stream and seal it in encoded requests of at most
256 KiB; the Go control envelope stays `operation/args`, at most 1 MiB. The
pure parsing helper takes an already bounded buffer and does not open a file.

The private `materialize_view` function takes source/destination paths from a
trusted adapter, the fixed parent manifest, selection rules, authenticated owner,
dataset and original operation UUID. The adapter must enter its source lease and
space reservation through the mandatory `guard` context. Its checkpoint verifies
current ACL, deletion/maintenance fences, cancellation and target reserve/inodes
before every chunk and publication. The helper has no ability to bypass those
checks or to dispatch a GPU job; no public RPC accepts paths or a guard callback.
An exception or leaving this context must not release a persistent source lease
while the transfer is PAUSED/UNKNOWN; its coordinator requires a trusted terminal
receipt before release. Only short-lived locks end with the worker invocation.

The operation binding, per-file durable ACK, and subset READY receipt are separate
records. ACKs bind the original UUID, owner, parent, selection and read mode.
Resume uses their confirmed offsets and prefix SHA, never an unacknowledged file
length. Unknown bytes after a lost ACK are overwritten only within that same
operation's private staging tree. Every selected file is copied and SHA-verified
against the parent manifest, then the selected tree is verified and published by
an atomic no-replace rename. A crash after writing READY but before publication
is recoverable with the same identity. Published files remain single-link and
read-only; existing `nlink==1` and source ctime checks remain intact.

READY means this **subset**, never the parent version or another transfer's ACK.
Target registration, budgets, training/download leases, deletion dependencies and
normal cache reclamation still need the subsequent integration change before any
capability is enabled. A subset must never count as a second complete copy in M2.
Storage projection will expose separate `logicalBytes` and `physicalBytes` fields
with unknown physical measurements left null, without treating two partial subsets
as a complete fixed version. Phase 1 rejects warehouse subset reads; it never
falls back to exposing the whole warehouse root. Managed hardlink reuse is deferred.

`requireSubsetCapability` rejects an absent, unknown or wrong node protocol with
409 `DATASET_SUBSET_UNSUPPORTED`. Source, target, and cache training capabilities
must each be freshly checked before acquiring leases or dispatching work. The
CLI cannot ship until real Windows Go-channel state, jobs, subset prepare and a
subset training job pass. Node installation belongs to the node release owner.

Related tests: `tests/dataset-subsets.test.js`, `tests/dataset-subset.test.py`, and
their shared `tests/fixtures/dataset-subsets.json` golden vectors.
