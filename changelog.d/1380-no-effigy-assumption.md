Nucleus no longer assumes Effigy, or any particular selector, in another
repository. The affected-tests rule now belongs only to a repository that
configures `affectedTests.command`: its worker and each revision run exactly
that command at the exact head, and the reviewer judges it there. A repository
that configures none reads no affected-tests instruction at all, so its
`AGENTS.md` Validate section and the brief's named proofs decide the covering
checks, and a reviewer never blocks for a missing affected run.

The Nucleus skill, and the worker, revision and reviewer prompts, therefore name
no Effigy affected-tests, baseline or QA selector for another repository; they
name the repository's own configured command, its baseline route, and milestone
QA via `project.qa.run`. Nucleus's own Effigy commands stay in its `AGENTS.md`.
