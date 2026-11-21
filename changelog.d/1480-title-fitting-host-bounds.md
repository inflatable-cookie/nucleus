Title fitting is now host-neutral: the Unicode-safe truncation lives in
`shared/title-fit.ts`, and each host adapter caps at its own bound — T3 row and
thread titles at `T3_TITLE_LIMIT`, Paseo workspace and agent titles at
`PASEO_TITLE_LIMIT`. Core hands titles through uncapped, so the old
Paseo-namespaced import is gone from generic workspace policy and telemetry.
Output is unchanged for the same bound.
