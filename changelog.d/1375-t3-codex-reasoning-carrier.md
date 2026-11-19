Codex profiles launch on T3. A codex model carries its thinking level on the
`reasoningEffort` select with no `role`, which T3's own client reads by option id;
the adapter now uses that same list, and a nested role resolves its options
against the role profile's own provider entry rather than the Nucleus ACP parent
model, which reports none. A snapshot that cannot answer yet — the provider is
still probing, or reports no model options at all — waits on the host instead of
refusing before send, while a settled snapshot with no carrier is still refused
and now lists the model's real option descriptors. Selection publishes the same
decision the launch fence applies, and `service.health`'s `t3code.modelShapes`
line reports the descriptors the last read carried.
