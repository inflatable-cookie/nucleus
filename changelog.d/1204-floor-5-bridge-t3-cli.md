The Paseo bridge, the T3Code host and the CLI are now one owner per mechanism,
with no behaviour change. `hosts/paseo/plugin/bridge.ts` keeps forwarding and
presence; spawning and replacing the service, the main-channel roll and the
bounded startup-output redaction each have their own module. `hosts/t3code/adapter.ts`
is the Host surface alone, with reads, the durable intent ledger and presentation
beside it; a recorded intent now stores its command kind and thread, so nothing
re-derives them by parsing the stored payload. `bin/queue-cli.mjs` is the front
door only, with the caller-stamping table, the source-stability bootstrap, this
run's ticket and the one versioned-write retry rule in their own modules.

Removed `bin/nucleus-dependencies.mjs`, `bin/nucleus-dispose.mjs` and
`bin/nucleus-promote.mjs`: three copies of the same versioned-write retry loop
that also skipped the caller the CLI records. The surviving operations are
`queue-cli task` and `nucleus-subscribe`, which retry only an idempotent write
whose failure is uncertain and never a definitive refusal.
