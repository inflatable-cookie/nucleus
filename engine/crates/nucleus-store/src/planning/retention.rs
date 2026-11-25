use crate::{DATABASE_FILE, StorageDirectory, Store, StoreError};
use rusqlite::{OpenFlags, TransactionBehavior, params};

impl Store {
    /// Trim older planning snapshots through the last sequence in a verified capture.
    /// Each record commits independently so writers can run between records.
    ///
    /// # Errors
    /// Returns the database or volume error. A later pass can resume safely.
    pub fn compact_planning_history(
        database: &StorageDirectory,
        captured_sequence: i64,
        now_ms: u64,
    ) -> Result<usize, StoreError> {
        database.verify()?;
        let mut db =
            Self::connect_database(&database.path().join(DATABASE_FILE), OpenFlags::empty())?;
        let keys = db
            .prepare("SELECT project,kind,id FROM planning_record_clocks")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let cutoff = i64::try_from(now_ms.saturating_sub(30 * 86_400_000)).unwrap_or(i64::MAX);
        let mut removed = 0;
        for (project, kind, id) in keys {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            removed += tx
                .prepare_cached(include_str!("retain.sql"))?
                .execute(params![project, kind, id, captured_sequence, cutoff])?;
            tx.commit()?;
        }
        Ok(removed)
    }
}
