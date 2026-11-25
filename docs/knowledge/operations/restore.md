# Recover the engine store

The Rust engine keeps task state in `engine.sqlite` under the verified database
root. Settings → Storage shows the active placement. Before upgrading an older
engine schema, the store makes a standalone SQLite backup in the configured
backup directory. It opens the copy read-only and verifies the application ID,
source schema version and SQLite quick check before publishing the backup as
`engine-before-v<source-version>-<suffix>.sqlite`.

A release roll is forward-only. If the operator directs recovery from a backup:

1. Keep dispatch paused. Record the source revision, backup schema version,
   running tasks and any native effects accepted since the backup.
2. Rehearse with a private copy. Open the backup read-only first. Verify its
   application ID (`N070`), expected `user_version` and `PRAGMA quick_check`.
   Open a separate writable copy with the intended engine to test the upgrade.
   Compare task and event contents, current delivery occurrences and pending
   native operations.
3. At the authorized switch, stop the engine writer, preserve the original
   database with its journal files and use the verified recovery copy. Keep
   dispatch paused while reconciling any post-backup sends against their exact
   native commands and receipts. Reading the same endpoint or seeing the same
   receipt sequence alone cannot establish continuity.
4. Confirm the schema, task states, outstanding deliveries and board. Restore
   the prior dispatch setting when the recovered state accounts for native work.

[Schema 12 upgrade and continuity rules](../specs/070-small-engine.md#parent-delivery-storage-and-upgrade)
describe the delivery evidence. For the retired TypeScript `queue.sqlite` and
its compressed snapshots, use the
[archived restore procedure](https://github.com/inflatable-cookie/nucleus/blob/c1771a0651636cbf1a69e5309ea62fff055efd3d/docs/knowledge/operations/restore.md).
