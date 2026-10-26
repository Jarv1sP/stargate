# Incremental copy batches implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user approved direct implementation; no additional plan approval is required.

**Goal:** Reduce small-file request and durable metadata overhead without interrupting existing work or losing original copy offsets.

**Architecture:** Keep the existing TLS archive-range reader. Coalesce adjacent small archive members into at most 1 MiB reads and store their bodies in one private SQLite transaction per batch. Existing per-file uploads and large-file offsets remain usable; project merge reads either original staged files or committed batch bodies.

**Tech stack:** Python 3.10 standard library, SQLite, existing copy/merge modules.

**Spec:** User-approved incremental small-file batching proposal; preserve source selection, original keys, TLS, size checks, atomic publication and existing target-use locks.

## Global constraints

- No dataset mutation, task cancellation or receiver restart for an existing copy waiting for its target project.
- No new transport, endpoint, dependency, hash, permission rule or workflow change.
- Only fresh small project-copy files are batched; old per-file records keep their existing resume path.
- Source reads remain bounded by 1 MiB; batch eligibility ends on a different archive, sparse gap, large file or previously received file.

## Review focus

- A short source response commits no batch or progress.
- A committed batch survives worker loss before progress publication without retransmission.
- Previously partial large/small uploads retain their original key and offset.
- Cancellation during a source read publishes no batch.
- Merge preserves bytes, modes, timestamps, links and unrelated target files.

## Task 1: Batch storage, receive and merge

Files: `node/copy-batches.py`, `node/transfer-jobs.py`, `node/project-sync.py`, `node/project-copy.py`, `tests/copy-batches.test.py`.

- [x] Add focused failing checks for coalesced reads, actual merged bytes, durable reopen, interrupted source, original partial offsets and cancellation.
- [x] Run the checks and confirm failures identify absent batching.
- [x] Implement `CopyBatches(root, write=False)` with bounded body transactions and read-only merge access.
- [x] Integrate bounded adjacent archive reads into incremental project-copy receive; preserve generic uploads and existing offsets.
- [x] Read committed small bodies during the existing atomic merge.
- [x] Run the focused checks and affected existing copy/merge checks; compare request and sync counts for equal payloads.

## Task 2: Review and delivery

Files: `docs/DATASETS.md`, `docs/USER_GUIDE.md` and the implementation above.

- [x] Document incremental batching and unchanged active-project waiting behavior.
- [ ] Obtain independent whole-change review, fix material findings, commit and open PR.
- [ ] Require existing PR/main CI and gray gates; publish through the existing private three-node scope.
- [ ] Observe actual copy state and active job continuity; never equate RUNNING with installation success.

## Execution ledger

- Approved: direct implementation of incremental small-file batching with original offsets and active work preserved.
- Ruling: use SQLite body transactions instead of a second packed-file/manifest format; this removes per-file durable upload records and keeps checkpoint recovery atomic with the standard library.
- Ruling: reuse current archive range requests, so no protocol or request-size limit changes are needed.
- Ruling: preserve streamed post-plan input with bounded lookahead; the post-plan filter recognizes durable batch bodies so it neither downloads nor counts them twice.
- First checks: the new batch fixture failed on individual requests and lost-progress replay before implementation; the original incremental-copy suite then caught streamed input and double-counted post-plan bodies. Both integration findings are covered by focused or existing checks before release.
- Verification scope: focused integrity and recovery checks locally; existing full CI/gray gates remain required for release. No GPU training or link-saturating test.

- Verification: copy-batches 10, replay 4, merge 11, resume control 8, project copy 19, GC 13, directory contract 22 and runtime 15 passed. Runtime's download marker now accepts its body inside a batch; the lock and original-file assertions remain.
- Independent review: streamed input and duplicate progress findings corrected and approved; CI/gray remain release gates.
