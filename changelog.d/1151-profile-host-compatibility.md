Each profile now shows whether it works on each host. `profile.compatibility`
answers works, unavailable, excluded or unknown per profile and host, with the
host's reason ("T3Code has no claude provider", "T3Code's codex has no mode
bypassPermissions") and the values a launch there sends. Settings → Profiles
shows a host chip on each row with the reason in its popover, and the profile
editor maps a profile's provider, model, mode, thinking level or options for
another host, or excludes it there. Selection reads both: a mapped profile
launches with the mapped values, and an excluded or incompatible one is never
chosen for that host's tasks. A task's routing policy lists the pool profiles
its host rules out or maps, and explains automatic worker selection: the demand
it computed, the profiles that met it, and why the chosen one won.
