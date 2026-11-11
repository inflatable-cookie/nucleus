#!/usr/bin/env node
// Effigy generic admission hook. Queue sets EFFIGY_ADMISSION_HOOK to this
// command in worker/reviewer environments. It asks Queue for a capacity slot,
// prints admit or deny, and holds until TERM. It never runs the workload.
const { runEffigyAdmissionHookMain } = await import("../core/qa/effigy-admission-hook.ts");
await runEffigyAdmissionHookMain();
