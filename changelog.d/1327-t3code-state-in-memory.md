The T3 host's durable state now lives in memory and the file keeps a bounded
history, so a service with several hosts connected stops burning its main loop on
the same record. On 2026-11-18 the state file was 12 MB and every status getter
re-read and re-parsed it: `service.health` and the board snapshot paid 35% of the
executor's samples for it, plus the garbage collection that came with it. The
service is the file's single owner: it loads and validates the record once, writes
through on every change (atomically, as before), and the host status lines and the
adapter's reads answer from memory. Settled commands past the newest window keep
their delivery receipt and lose the message or launch body that made the file
heavy; an unresolved delivery, a pre-send refusal and a receipt a later exact
lookup parses are kept as recorded.
