use std::{cell::RefCell, collections::BTreeMap, future::Future, sync::Mutex};

/// Counts by RPC method. WebSocket tickets and upgrades are counted separately.
pub type HostCalls = BTreeMap<&'static str, u64>;

tokio::task_local! {
    static PASS_CALLS: RefCell<HostCalls>;
}

#[derive(Default)]
pub(crate) struct Traffic {
    calls: Mutex<HostCalls>,
    thread_reads: Mutex<HostCalls>,
}

impl Traffic {
    pub(crate) fn record(&self, method: &'static str) {
        *self
            .calls
            .lock()
            .expect("host traffic")
            .entry(method)
            .or_default() += 1;
        let _ = PASS_CALLS.try_with(|calls| {
            *calls.borrow_mut().entry(method).or_default() += 1;
        });
    }

    pub(crate) fn totals(&self) -> HostCalls {
        self.calls.lock().expect("host traffic").clone()
    }

    pub(crate) fn record_thread_read(&self, reason: &'static str) {
        *self
            .thread_reads
            .lock()
            .expect("thread reads")
            .entry(reason)
            .or_default() += 1;
    }

    pub(crate) fn thread_reads(&self) -> HostCalls {
        self.thread_reads.lock().expect("thread reads").clone()
    }
}

pub(crate) async fn measure<T>(work: impl Future<Output = T>) -> (T, HostCalls) {
    PASS_CALLS
        .scope(RefCell::default(), async {
            let result = work.await;
            (result, PASS_CALLS.with(RefCell::take))
        })
        .await
}
