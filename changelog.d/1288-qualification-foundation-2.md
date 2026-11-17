Qualification foundation, tranche 2 (Spec 064 P4): a qualification run now has
one combined raw capture artifact with real per-stream EOF and drain evidence,
strict durability reporting and no second log.

- **One artifact.** The private qualification capture keeps exactly one
  mode-0600 `qualification.raw` beside the run: `NQRAW001` then 22-byte
  big-endian frames (kind, stream, global sequence, per-stream offset, length),
  with DATA frames of 1–65,536 bytes written through short-write loops. There is
  no per-stream file, cap, redaction, archive or duplicate copy, and the ordinary
  `stdout`/`stderr` files are never opened in this mode. Each stream gets one EOF
  frame on its real pipe EOF and one DRAIN frame after its payload writes, at its
  final offset; an empty stream still gets both. Sequence, offsets, payload counts
  and the artifact and per-stream hashes accumulate as frames land, and the file's
  size is exactly `8 + B + 22 × (N + 4)` bytes.
- **Real terminal events.** `executeHookProgram` gained an opt-in stricter capture
  mode: observer faults latch and reject the step instead of being dropped, each
  stream's real `end` and its following drain are reported separately, and no pipe
  is destroyed to manufacture completion.
- **Strict durability.** The capture's `close()` reports write, marker, fsync,
  close and directory-sync faults instead of swallowing them and keeps a partial
  artifact; `writeVerifiedOwnedFile` returns what it proved durable, with the
  published directory entry reported as its own fact.
- **Strict validation.** A validator rejects unknown kinds or streams, sequence
  gaps, wrong offsets or lengths, duplicate or missing terminal markers, DATA
  after EOF, DRAIN before EOF, partial frames and trailing bytes.

Qualification mode stays opt-in and inaccessible: every mode entry still refuses
before any effect with `qualification foundation incomplete`, so no real proof
creates the artifact, and nothing reads or exports it. An ordinary host run keeps
its two files, its token redaction and its 8 MiB per-stream cap unchanged.
