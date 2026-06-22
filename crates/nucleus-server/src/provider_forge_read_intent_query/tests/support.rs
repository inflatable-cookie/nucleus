mod credential_status;
mod pull_request;
mod repository_metadata;
mod status_check;

use crate::ServerStateService;
use nucleus_local_store::LocalStoreBackend;

pub fn persist_sources<B>(state: &ServerStateService<B>)
where
    B: LocalStoreBackend,
{
    credential_status::persist(state).expect("persist credential");
    repository_metadata::persist(state).expect("persist repository");
    pull_request::persist(state).expect("persist pull request");
    status_check::persist(state).expect("persist status check");
}
