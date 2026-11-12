T3 threads carry the profile's thinking level, and an ordinary task's whole
lifecycle runs on T3. The T3 catalog now reports each model's real option
choices from `server.getConfig`, worker and reviewer launches map the profile's
`thinkingOptionId` and feature values into the nightly's `modelSelection.options`,
and routing keeps a profile the task's host cannot run out of selection instead
of refusing at launch. A proven refusal at a creation names the step that failed
(worker creation, not "reviewer continuation") and skips the absent-creation
ladder. Workspace archive is now the native `project.update` `archived` mutation
(threads and files are kept), reopening an archived project reuses its
registration, and atomic interrupt-and-continue steers the live run through the
nightly's `steer_active` dispatch mode. An end-to-end test drives a T3-bound
task from promotion through closeout on the fake Nightly transport.
