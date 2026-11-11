# Restore the Nucleus store

Use a verified `.sqlite.gz` snapshot from `<work-root>/queue/backups` for the live store; a private `NUCLEUS_DATA_HOME` instance or fixture uses its own `<data dir>/backups/`. The data directory is `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set.

Work placement comes from `workRoot` in `settings.json` or the
`NUCLEUS_WORK_ROOT` environment override. A fresh install uses a portable
root at `~/.nucleus/work`. Optional `workVolumeId` (or
`NUCLEUS_WORK_VOLUME_ID`) pins a volume. Existing mount-rooted records adopt
their common root and its observed volume ID once, preserving the guard. If that volume is away,
`backup.list` reports it unavailable; no backup falls back to another drive.
Retired paths outside the active placement are never read or listed.

1. Run `paseo plugin disable nucleus`. Wait for the Nucleus service to stop.
   Do not restore while it owns the store.
2. Set `data_dir` to the Nucleus data directory and `snapshot` to the chosen
   `.sqlite.gz` file. Keep both paths quoted in shell commands.
3. Prepare and verify the snapshot in a private temporary directory before
   moving any managed files. The verifier accepts schemas 50 through 58; use an
   older build to upgrade an older snapshot first.

   ```sh
   restore_probe_dir="$(mktemp -d)"
   chmod 700 "$restore_probe_dir"
   gzip -dc "$snapshot" > "$restore_probe_dir/queue.sqlite"
   node --experimental-sqlite -e '
     const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1], { readOnly: true });
     try {
       const check = db.prepare("PRAGMA integrity_check").get().integrity_check;
       const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema");
       const schema = JSON.parse(row.value);
       if (check !== "ok" || !Number.isInteger(schema) || schema < 50 || schema > 58)
         throw new Error(`Unsupported or corrupt snapshot (schema ${schema}); the store opens schema 50 through 58`);
     } finally { db.close(); }
   ' "$restore_probe_dir/queue.sqlite"
   ```

   Continue only if both commands succeed. On failure, remove the private
   directory and select a supported snapshot; the managed store remains in place.
4. Move the current SQLite file set aside, then install the verified file. Keep
   the replaced files until the restored store has been checked:

   ```sh
   replaced_dir="$data_dir/replaced-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$replaced_dir"
   for file in "$data_dir/queue.sqlite" "$data_dir/queue.sqlite-wal" "$data_dir/queue.sqlite-shm"; do
     if test -e "$file"; then mv "$file" "$replaced_dir/"; fi
   done
   mv "$restore_probe_dir/queue.sqlite" "$data_dir/queue.sqlite"
   chmod 600 "$data_dir/queue.sqlite"
   rm -rf "$restore_probe_dir"
   ```

5. Run `paseo plugin enable nucleus`, then
   `paseo plugin reload nucleus`. Check `backup.list` and a known task or
   planning record before removing any replaced files.

The backup files stay in place. A restore replaces only the SQLite file set;
other Nucleus settings and plugin files remain in the data directory. The
`backup-status.json` beside the store is Nucleus's record of the last backup
failure; leave it for Nucleus to clear on its next successful snapshot.
