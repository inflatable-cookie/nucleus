# Recover the engine store

The Rust engine keeps task state in `engine.sqlite` under the verified database
root. Settings → Storage shows the backup status and scheduled archive root.
On disk, select a recovery point from before the incident and record its
filename and time.

- **Scheduled backups** are in the displayed archive root. Their names end in `-rust-<uuid>.<tier>.sqlite.gz`
  for the hourly, daily and weekly tiers. The default engine home uses Barge’s
  archives class for `nucleus-backups`. An isolated home uses its own backup
  directory. Decompress the selected archive into a fresh private directory.
- **Pre-upgrade backups** are standalone files named
  `engine-before-v<source-version>-<suffix>.sqlite` in the configured backup
  directory. Copy the selected file directly into the private directory.

With `backup` set to the selected file’s absolute path and `scratch` set to
the verified scratch directory, prepare the read-only check:

```sh
(
  set -eu
  umask 077
  recovery=$(mktemp -d "${scratch:?}/nucleus-restore.XXXXXXXX")
  case "$backup" in
    *-rust-*.sqlite.gz) gzip -dc "$backup" > "$recovery/check.sqlite" ;;
    */engine-before-v*.sqlite) cp "$backup" "$recovery/check.sqlite" ;;
    *) exit 1 ;;
  esac
  sqlite3 -readonly "$recovery/check.sqlite" \
    "SELECT printf('%08X', application_id) FROM pragma_application_id;
     PRAGMA user_version; PRAGMA integrity_check;"
  printf 'Recovery copy: %s\n' "$recovery/check.sqlite"
)
```

Proceed only when the results are `4E303730` (`N070`), the expected source
schema version, and `ok`.

A release roll is forward-only. If the operator directs recovery from a backup:

1. Keep dispatch paused. Record the source revision, backup schema version,
   running tasks and any native effects accepted since the backup.
2. Rehearse with a separate writable copy of the checked database. Open it
   with the intended engine to test the upgrade. The engine refuses a backup
   older than schema 14; upgrade that copy with an earlier release first.
   Compare task and event contents, current delivery occurrences and pending
   native operations.
3. At the authorized switch, stop the engine writer, preserve the original
   database with its journal files and use the verified recovery copy. Keep
   dispatch paused while reconciling any post-backup sends against their exact
   native commands and receipts. Reading the same endpoint or seeing the same
   receipt sequence alone cannot establish continuity.
4. Confirm the schema, task states, outstanding deliveries and board. Restore
   the prior dispatch setting when the recovered state accounts for native work.

[Upgrade and continuity rules](../specs/070-small-engine.md#parent-delivery-storage-and-upgrade)
describe the delivery evidence. For the retired TypeScript `queue.sqlite` and
its compressed snapshots, use the
[archived restore procedure](https://github.com/inflatable-cookie/nucleus/blob/c1771a0651636cbf1a69e5309ea62fff055efd3d/docs/knowledge/operations/restore.md).
