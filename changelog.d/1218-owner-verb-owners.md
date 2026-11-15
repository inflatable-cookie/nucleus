The owner verbs now have one owner per mechanism. The control dispatcher's
authority proof, receipt acceptance, budget extension, durable retry rule and
outcome record are separate modules; `owner stop`'s recorded-verb replay and the
reviewer's automatic continuation are separate modules; `restart` hands each shape
to the owner that serves it (worker, reviewer, resolution episode, proof-executor
re-report, stalled-turn stop); `retry_effect` separates replay, pre-settlement,
recovery settlement, archive retries and ordinary effects; and a brief amendment
separates routing, the proof declaration and delivery.

Decisions drawn from refusal text are now typed facts. A stale owner control throws
one typed `TaskChangedRefusal` and the re-read hint comes from it rather than from a
message pattern; the reviewer auto-continue retry window is decided by the run and
incident fence facts recorded at the refusal, not by matching its words; disposition
hook evidence is decoded as hook records by their schema, and the legacy
instruction-artifact rule reads the recorded artifact absence instead of matching
its prose. Effect keys are decoded once (`splitOwnerEffectKey`) instead of by prefix
slicing in every handler.

A brief amendment recorded while its host had no message channel is now delivered by
the next pass, and an attempted send whose outcome is unknown is recorded as unknown
and never resent; previously such an intent was only ever sent from the amendment
itself. Behaviour is otherwise unchanged.
