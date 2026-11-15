Milestone QA's runner is split into one owner per mechanism — request identity and admission,
placement, host-run scheduling, supervisor handoff, observation, recovery, settlement, teardown
retry and retention — and the runner is now the composition of those owners. A QA admission refusal
records a typed code on its durable request, so the scheduler resumes a batch from the code instead of
matching diagnostic text, and a settlement notice that cannot be delivered is recorded on the run
instead of being dropped. Settled QA checkout retention runs on the hourly retention pass rather than
a board read. The author-side proof executor's module is likewise split into its refusal codes,
receipts and declarations, dispatch admission, source proof, selector evidence, and proof-wait policy;
the QA re-export of the proof executor agent list is removed.
