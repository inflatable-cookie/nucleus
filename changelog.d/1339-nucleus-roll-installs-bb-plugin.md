A service roll now keeps BB's installed Nucleus plugin on the build it lands. When BB
has the plugin installed from another build, the roll runs the activated version's own
`nucleus bb status` and, only for a plugin BB reports as `behind`, that version's
`nucleus bb install` — the same route, including the read-only managed copy, so no roll
writes into an installed version directory. A machine without the plugin is untouched, a
plugin that is not ours is left alone, and a failed install is reported in the roll record
and in `service.health` (`bbPlugin`, from owner-only `queue-bb-plugin-roll.json`) without
failing or reverting the roll; the next landed roll retries it. This ends the two
2026-11-18 rolls that left BB offline behind a plugin at the previous build until someone
ran `nucleus bb install` by hand.
