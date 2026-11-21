Normalized host-owned workspace placement and initialization-lock provenance
behind host adapter boundaries: shared workspace types, schemas, and core
policy now read host-neutral placement and provenance facts (`hostOwnedWorktree`
and host-supplied initialization lock rules) while Paseo's adapter interprets
Paseo's native workspace descriptor and `"initializing"` lock. Persisted and
wire external-archive records adapt legacy `isPaseoOwnedWorktree` fields at the
boundary without broadening permission, and `paseo.json` `worktree.setup`
compatibility remains active.
