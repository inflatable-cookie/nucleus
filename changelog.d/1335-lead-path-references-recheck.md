Prerequisites named by task reference (`owner/repo#072`, `repo#72`, zero-padded or not) now resolve on the lead check, `lead.submit`, promotion and `set_dependencies`, and are stored as the prerequisite's UUID. An unknown reference still refuses by name.

`lead.submit` checks an edited lead's new version instead of returning the check it held before the edit.

`lead.check` accepts an optional `hostId`, and resolves a brief's origin host from the calling thread's identity the way `lead.submit` does, so a notifying brief no longer refuses with "Origin host is unknown or ambiguous" for a caller whose submission is accepted. An ambiguous identity still refuses.
