# Swallowtail Native Pilot First Defect

Date: 2026-07-25

## Outcome

The approved native pilot launched through the normal bundled Nucleus app.
Catalogue discovery confirmed exact `gpt-5.4-mini`, low reasoning, and the
unchanged ChatGPT audience.

The first ordinary Agent Chat action failed before provider-session open or
turn persistence with:

`swallowtail.codex.preparation.tool_schema_limit`

Safe evidence reports zero turns. No provider thread opened, no Nucleus-owned
Codex child remained, and no fixture or workspace write occurred.

## Ownership And Repair

Swallowtail's prepared Codex facade had invented a 4 KiB input-schema ceiling.
Nucleus supplied two finite, bounded, valid JSON Schema declarations through
the existing consumer bridge.

Swallowtail commit `54fbbc2af4e1615bed67815037aa2bcd6cc91dcb`
now derives exact tool count and maximum schema bytes from those declarations.
Its regression covers two tools and a schema above 8 KiB. All 90
Codex-adapter tests pass.

Nucleus requires no product, prompt, tool, persistence, authorization, or UI
change for this defect.

## Deviation

The failed launch made no model turn but consumed one catalogue attempt.
Swallowtail recommends retaining it as pre-turn defect evidence and permitting
4 physical launches and 4 catalogue attempts total, so the unchanged
12-planned-turn workload still runs across 3 clean launches.

The 15-turn maximum, 6 provider threads, 3 live children, serial execution,
read-only effects, and original 60-minute ceiling do not increase.

## Next

The operator approved the one-launch, one-catalogue reset on 2026-07-26. The
paused interval does not consume the 60-minute execution window. The retained
catalogue remains attempt one of four.
