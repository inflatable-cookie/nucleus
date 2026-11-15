Four Nucleus quality modules now have one owner for the mechanisms they were rated on, with no change to
task behaviour:

- **Detached supervisors** (`core/qa/supervisor-process.ts`) start and stop the same way everywhere:
  milestone QA, project validation and host runs share one launch and one stale stop, and a supervisor is
  always identified by its recorded start identity rather than a command-line substring.
- **Project validation** records a fault that escapes its background gate, so an unexpected throw is
  visible on the task instead of disappearing with the promise.
- **Milestone QA inspection** holds a run whose plan or heartbeat exists but cannot be read, instead of
  reading that as a run that never started. Supervision files are read by one owner-only reader.
- **The proof-only release GO** is decided from the reviewer run's own recorded intent rather than the
  wording of the prompt it was handed, so re-wording a prompt cannot silently close the wait.
- **The Effigy run-status client** drops the follow-logs, capability probe and help classifier that had no
  product caller, lets a producer record always decide before producer text, and bounds the output one
  status call collects.
