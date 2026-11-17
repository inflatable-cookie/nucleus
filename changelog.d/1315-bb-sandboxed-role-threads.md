A BB role thread can deliver its report from inside its provider sandbox, and a
BB task workspace now carries its pinned sibling checkouts beside the checkout,
so a relative `../<sibling>` path resolves as it does on Paseo. A run ticket
names its host; a `bb:` ticket's report helper posts the same payload to the BB
plugin's loopback relay, which forwards it to the run's own callback socket from
the BB server process, outside the sandbox (Claude Code's sandbox refuses every
Unix socket but leaves loopback reachable). The service also creates a BB run's
owner-only scratch leaf before its thread exists and refuses the launch when the
leaf cannot be proved. Effigy itself still cannot run inside Claude Code's
sandbox: it reads its boot identity with `kern.bootsessionuuid`, which that
sandbox refuses, and no sandbox allowance is exposed to fix it.
