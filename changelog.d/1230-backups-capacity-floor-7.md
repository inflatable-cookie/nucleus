The backup worker reads a snapshot's file name in one place, so the listing, the scheduled due check and
the live-home retention pass agree on what a snapshot is called and when it was taken. Daily and weekly
tiers are linked by one rule shared by both publication paths, and a backup status file that cannot be
read is now reported as the backup failure instead of reading as a healthy backup.

Slot admission names the limit that refuses a request as a typed fact rather than matching the word
"Global" in the wait text, reads its two dispatch-pass facts through one cached reader, and writes every
wait label through one rule. The pending snapshot verification faults a test injects no longer ship in
the worker; no behaviour changes.
