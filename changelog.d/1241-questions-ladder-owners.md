The question service now has one owner per mechanism, and every operator-question record it reads is decoded once instead of sliced from event text.

`core/questions/questions.ts` is the service's shared in-flight state only. Raising is split by mechanism: `question-raises.ts` decides a question is due, `question-raise-routes.ts` owns where one raise goes and the deferred it resolves, `question-answers.ts` owns what an answer does, and `question-recovery.ts` runs the resume sweep. `core/questions/question-events.ts` decodes the raise intent and the exact question it names, the decision link, the marks that fence a re-raise, the native request identity and the payloads a restart recovers.

The blocker ladder half of the same rating row was already delivered by the ladder's own consolidation, whose owners this imports unchanged. No behaviour, guard or protocol rule changed.
