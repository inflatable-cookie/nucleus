use nucleus_store::TaskNumberSeed;

use crate::{Service, ServiceError};

impl Service {
    /// Backfill the bound repository before starting the HTTP server and scheduler.
    ///
    /// # Errors
    /// Returns an error if the volume or the numbering transaction is unavailable.
    pub async fn seed_task_numbers(&self, seed: &TaskNumberSeed) -> Result<(), ServiceError> {
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        state.store.seed_task_numbers(seed)?;
        if self.acp_provider().is_some() {
            for row in
                state.store.list()?.into_iter().filter(|row| {
                    row.number.is_some() && self.task_scope(row.task.identity()).is_ok()
                })
            {
                self.desire_title(&state, &row.task, row.reference().as_ref(), None);
            }
        }
        Ok(())
    }
}
