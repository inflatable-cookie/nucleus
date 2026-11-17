Qualification foundation, tranche 1 (Spec 064 P1–P3): a host-run can now carry
an authenticated proof subject, retain its detached supervisor's actual child
exit, and stop by signalling only the one direct command.

- **Proof subject.** A qualification binding (task, participant run,
  authorization and operation, brief version and digest, published head and tree,
  ordered input digests, declared selector, plus the bound host run, executable
  digest, literal argv, cwd and the canonical digest of the effective environment
  values) is owned by `shared/schema/review/proof.ts`, carried by an opted-in
  proof run's intent and accepted by the private supervisor plan. Qualification
  mode is opt-in at the proof declaration, so an ordinary proof execution records
  none of it. The host-run endpoint's
  private `submitQualification` authenticates the executor run's own credential
  and resolves that subject from Nucleus's records before any submit write; a
  host-run token or a client-supplied caller grants nothing. The source is
  rechecked before the submit and again before acceptance.
- **Retained children.** `spawnDetachedSupervisor` can return the parent's actual
  child exit promise, so the service holds its supervisor's exit for the whole
  attempt, and `executeHookProgram` records its own direct-command exit
  observation, with both start identities, before any group settlement.
- **Direct-command stop.** `stopMode: qualification_direct` sends TERM to the
  still-held direct command only: no process group, no escaped descendant, no
  SIGKILL escalation, and never the supervisor as a cleanup shortcut. A cancel
  request persists the mode.

Qualification mode stays opt-in and inaccessible: until the later tranches land
their named missing-input refusal, every mode entry refuses before any effect with
`qualification foundation incomplete` — a declared opt-in is refused at proof
activation and at the dispatch funnel before an executor run exists, a submit
performs no token-key work before it authenticates, and the supervisor refuses a
qualification plan before its first write — and no qualification proof runs.
Ordinary host runs, QA and proof executions keep their existing behaviour.
