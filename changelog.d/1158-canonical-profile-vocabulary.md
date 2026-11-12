Profiles use one canonical vocabulary for providers, thinking levels and runtime
modes, and each host translates it in code: Paseo spells Claude's full access
`bypassPermissions` and carries Grok's as `auto_accept`; T3Code names Claude
`claudeAgent` and carries thinking as an `effort` or `thinking` option. A value a
host can't express makes the profile unavailable there, with the reason. Stored
profiles move to the canonical values once; an unknown value is kept and
reported. Settings → Profiles edits canonical values only, offers what at least
one host can run (`profile.vocabulary`), and shows one quiet warning icon when a
profile can't run on a host. The per-profile host chips, mapping editor and
exclusions, and the provider map with `profile.providers`, are removed.
