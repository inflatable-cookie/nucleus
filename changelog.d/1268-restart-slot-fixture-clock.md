Fixed the `recovery-wait-restart-lifecycle` fixture clock: its fixed
2026-11-16 activity timestamps aged past the 180-minute wall-clock budget, so
the launch inside the restart slot tests parked the task on a budget stop and
fenced the restart hold. The fixture now pins activity a few minutes ago, so
owner restart keeps the slot it held and a fenced hold keeps none.
