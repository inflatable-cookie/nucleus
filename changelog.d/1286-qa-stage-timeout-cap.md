Milestone QA stage timeouts can now total up to 6 hours: `repository.set`
accepts a single QA `timeoutMs` or staged `stages` timeouts up to
`PROJECT_QA_TIMEOUT_MAX_MS` (21,600,000 ms), and an admitted staged run's
`runTimeoutMs` is at least the stage total plus the setup and teardown
allowance (or the default, whichever is larger), so a long root stage is never
killed by the run timeout before its own limit.
