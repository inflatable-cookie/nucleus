//! Native titles are an independent presentation effect.

use std::time::Duration;

use nucleus_core::{HoldBy, Phase, Review, Role, Task, Verdict, WaitReason};
use nucleus_store::{TaskRow, TitleReceipt};

use crate::{Service, ServiceError, State, now_ms, pass::DispatchTarget, presentation};

const T3_TITLE_LIMIT: usize = 200;

pub(super) fn child_title(task: &Task, role: Role) -> String {
    let role = if role == Role::Reviewer {
        " review"
    } else {
        ""
    };
    fit(&format!(
        "{}{role}: {}",
        task.identity().reference,
        brief(task)
    ))
}

fn task_title(task: &Task, wait: Option<WaitReason>) -> String {
    let phase = match task.phase() {
        Phase::Queued => "Queued",
        Phase::Working
            if matches!(
                task.verdict(),
                Some(Verdict::Reviewed {
                    decision: Review::Changes,
                    ..
                })
            ) =>
        {
            "Changes"
        }
        Phase::Working => "Working",
        Phase::Reviewing => "Reviewing",
        Phase::Merging => "Merging",
        Phase::Closing => "Closing",
        Phase::Done => "Done",
        Phase::Cancelled => "Cancelled",
    };
    let label = if task.phase().is_terminal() {
        phase.into()
    } else if task.operator_question().is_some() && task.operator_decline().is_none() {
        "Waiting on Tom".into()
    } else if let Some(hold) = task.hold() {
        if task
            .run()
            .is_some_and(|run| !run.revoked() && run.last_send_at_ms().is_some())
        {
            format!("{phase}*")
        } else if let Some(target) = reference(&hold.reason) {
            format!("Waiting on {target}")
        } else {
            match (task.phase(), hold.by) {
                (Phase::Merging, Some(HoldBy::Operator)) => "Merge held by Tom",
                (Phase::Merging, Some(HoldBy::Planner)) => "Merge held by planner",
                (Phase::Merging, None) => "Merge held",
                (_, Some(HoldBy::Operator)) => "Waiting on Tom",
                (_, Some(HoldBy::Planner)) => "Held by planner",
                (_, None) => "Held",
            }
            .into()
        }
    } else {
        match wait {
            Some(WaitReason::Capacity) => "Waiting for capacity",
            Some(WaitReason::HostUnknown | WaitReason::IdleWithoutTerminalRun) => {
                "Waiting on Nucleus"
            }
            _ => phase,
        }
        .into()
    };
    fit(&format!(
        "{label}: {} {}",
        task.identity().reference,
        brief(task)
    ))
}

fn brief(task: &Task) -> String {
    let text = task
        .brief()
        .declared_title()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| presentation::brief_title(&task.brief().text).map(str::to_owned))
        .unwrap_or_else(|| "Task".into());
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.rsplit_once(' ')
        .filter(|(_, last)| last.eq_ignore_ascii_case("worker"))
        .map_or(flat.as_str(), |(title, _)| title)
        .to_owned()
}

fn reference(reason: &str) -> Option<&str> {
    reason.split_whitespace().find_map(|word| {
        let text = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '#');
        let (repo, id) = text.split_once('#')?;
        (repo.len() <= 40
            && repo
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b".-_".contains(&ch))
            && !id.is_empty()
            && id.len() <= 16
            && id.bytes().all(|ch| ch.is_ascii_hexdigit()))
        .then_some(text)
    })
}

fn fit(title: &str) -> String {
    let title = presentation::excerpt(title, usize::MAX);
    if title.encode_utf16().count() <= T3_TITLE_LIMIT {
        return title;
    }
    let mut units = 0;
    let mut end = 0;
    for (offset, letter) in title.char_indices() {
        units += letter.len_utf16();
        if units >= T3_TITLE_LIMIT {
            break;
        }
        end = offset + letter.len_utf8();
    }
    let prefix = &title[..end];
    let stop = prefix
        .rfind(char::is_whitespace)
        .filter(|&offset| offset > 0)
        .unwrap_or(end);
    format!("{}…", prefix[..stop].trim_end())
}

impl Service {
    pub(super) fn desire_title(&self, state: &State, task: &Task, wait: Option<WaitReason>) {
        if self.project.acp_provider.is_none() {
            return;
        }
        let id = &task.identity().id;
        let path =
            nucleus_work::checkout_path(self.storage.work().path(), &self.project.repository, id);
        let thread = nucleus_hosts::parent_thread(&path);
        match state
            .store
            .desire_title(id, &thread, &task_title(task, wait))
        {
            Ok(true) => self.title_wake.notify_one(),
            Ok(false) => {}
            Err(error) => eprintln!("{id}: {error}"),
        }
    }

    pub(super) async fn watch_titles(&self) {
        let (Some(provider), Some(root)) = (
            self.project.acp_provider.as_deref(),
            self.project.checkout.to_str(),
        ) else {
            return;
        };
        loop {
            let next = self.title_work(&self.host.title_threads(root)).await;
            let wait = match next {
                Ok(Some((thread, receipt))) => {
                    let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
                    if receipt.retry_at > now {
                        Some(Duration::from_millis(receipt.retry_at.abs_diff(now)))
                    } else {
                        if let Err(error) = self.apply_title(provider, &thread, &receipt, now).await
                        {
                            eprintln!("{}: {error}", receipt.task_id);
                        }
                        // The next due candidate can run before this title retries.
                        continue;
                    }
                }
                Ok(None) => None,
                Err(error) => {
                    eprintln!("{error}");
                    Some(Duration::from_secs(5))
                }
            };
            tokio::select! {
                () = self.title_wake.notified() => {}
                () = self.host.title_shell_changed() => {}
                () = async {
                    if let Some(delay) = wait { tokio::time::sleep(delay).await; }
                    else { std::future::pending().await }
                } => {}
            }
        }
    }

    async fn title_work(
        &self,
        threads: &[String],
    ) -> Result<Option<(String, TitleReceipt)>, ServiceError> {
        let state = self.state.lock().await;
        let mut earliest: Option<(String, TitleReceipt)> = None;
        for thread in threads {
            if let Some(receipt) = state.store.pending_title(thread)?
                && earliest
                    .as_ref()
                    .is_none_or(|(_, prior)| receipt.retry_at < prior.retry_at)
            {
                earliest = Some((thread.clone(), receipt));
            }
        }
        Ok(earliest)
    }

    async fn apply_title(
        &self,
        provider: &str,
        thread: &str,
        receipt: &TitleReceipt,
        now: i64,
    ) -> Result<(), ServiceError> {
        {
            let state = self.state.lock().await;
            if !state.store.defer_title(receipt, now)? {
                return Ok(());
            }
        }
        let row = self.task(&receipt.task_id).await?;
        let fence = self.task_fence(&receipt.task_id).await;
        let Ok(_guard) = fence.try_lock_owned() else {
            return Ok(());
        };
        if !self.title_current(&row, thread, receipt).await? {
            return Ok(());
        }
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(
            &self.project.checkout,
            &self.project.repository,
            &receipt.task_id,
        )?;
        let binding = self.binding(&checkout)?;
        let Some(target) = self
            .project
            .checkout
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
            .filter(|target| target.thread() == thread)
        else {
            return Ok(());
        };
        let destination = DispatchTarget::Title {
            frozen: target.binding(),
            checkout: &checkout,
        };
        if self.dispatch_gate(&row.task, destination).await?.is_none() {
            return Ok(());
        }
        let key = format!("task-{}-title-{}", receipt.task_id, receipt.generation);
        self.host
            .write_title(target, &key, &receipt.desired)
            .await?;
        self.state.lock().await.store.confirm_title(receipt)?;
        Ok(())
    }

    async fn title_current(
        &self,
        expected: &TaskRow,
        thread: &str,
        receipt: &TitleReceipt,
    ) -> Result<bool, ServiceError> {
        let state = self.state.lock().await;
        let current = self.lookup(&state, &receipt.task_id)?;
        Ok(current.version == expected.version
            && state
                .store
                .pending_title(thread)?
                .is_some_and(|pending| pending.generation == receipt.generation))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nucleus_core::{Authority, Command, Entry, Identity};
    use nucleus_forge::GitHub;
    use serde_json::json;

    use super::*;
    use crate::{
        event,
        tests::{fixture, native_fixture},
    };

    fn task() -> Task {
        Task::new(
            Identity {
                id: "fixture".into(),
                reference: "fixture#1".into(),
                repository: "example/fixture".into(),
                base: "main".into(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "---\ntitle: Add a greeting worker\n---\n\n# Different heading".into(),
            None,
        )
    }

    #[test]
    fn title_policy_formats_reference_roles_and_waits() {
        let mut task = task();
        assert_eq!(
            child_title(&task, Role::Worker),
            "fixture#1: Add a greeting"
        );
        assert_eq!(
            child_title(&task, Role::Reviewer),
            "fixture#1 review: Add a greeting"
        );
        assert_eq!(
            task_title(&task, Some(WaitReason::Capacity)),
            "Waiting for capacity: fixture#1 Add a greeting"
        );
        assert_eq!(
            task_title(&task, Some(WaitReason::HostUnknown)),
            "Waiting on Nucleus: fixture#1 Add a greeting"
        );
        let authority = Authority::Planner {
            actor: "planner".into(),
        };
        let obs = nucleus_core::Observation {
            host: nucleus_core::Observed::Unknown,
            forge: nucleus_core::Observed::Unknown,
            workspace: nucleus_core::Observed::Unknown,
        };
        task.command(Command::Hold("After (fixture#2).".into()), &authority, &obs)
            .expect("hold");
        assert_eq!(
            task_title(&task, Some(WaitReason::Hold)),
            "Waiting on fixture#2: fixture#1 Add a greeting"
        );
        task.command(Command::Hold("Wait for copy".into()), &authority, &obs)
            .expect("hold");
        assert_eq!(
            task_title(&task, Some(WaitReason::Hold)),
            "Held by planner: fixture#1 Add a greeting"
        );
        task.command(Command::Cancel, &authority, &obs)
            .expect("cancel");
        assert_eq!(
            task_title(&task, Some(WaitReason::Stopping)),
            "Cancelled: fixture#1 Add a greeting"
        );
        let prefix = "🔬 ".repeat(66);
        assert_eq!(
            fit(&format!("{prefix}word")),
            format!("{}…", prefix.trim_end())
        );
    }

    #[tokio::test]
    async fn title_write_uses_the_existing_shell_without_an_exact_read() {
        let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
        let task = task();
        let subject = Task::new(
            Identity {
                repository: service.project.repository.clone(),
                ..task.identity().clone()
            },
            task.brief().text.clone(),
            None,
        );
        let id = &subject.identity().id;
        let worktrees = service.worktrees().expect("fixture worktrees");
        let checkout = worktrees
            .checkout(&service.project.checkout, &service.project.repository, id)
            .expect("checkout");
        checkout.allocate(&service.project.start).expect("allocate");
        let binding = service.binding(&checkout).expect("workspace binding");
        let parent = nucleus_hosts::parent_thread(checkout.path());
        let root = service.project.checkout.clone();
        let shell = json!({"kind":"snapshot","snapshot":{"projects":[{"id":binding.project_id,"workspaceRoot":root}],
            "threads":[{"id":parent,"projectId":binding.project_id,"providerInstanceId":"fixture-acp",
            "worktreePath":binding.worktree_path,"branch":binding.branch,"title":"old title"}]}});
        let expected = parent.clone();
        let (host, native) = native_fixture(move |req| match req["tag"].as_str() {
            Some("orchestration.subscribeShell") => {
                json!({"_tag":"Chunk","requestId":req["id"],"values":[
                    shell, {"kind":"synchronized"}
                ]})
            }
            Some("orchestration.dispatchCommand") => {
                assert_eq!(
                    req["payload"],
                    json!({"type":"thread.metadata.update","threadId":expected,
                    "commandId":"task-fixture-title-1","title":"Queued: fixture#1 Add a greeting"})
                );
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            }
            _ => panic!("title work must not read any other host state"),
        })
        .await;
        service.host = host;
        service.project.acp_provider = Some("fixture-acp".into());
        {
            let mut state = service.state.lock().await;
            state
                .store
                .create(&subject, &event("admitted"))
                .expect("seed task");
            service.desire_title(&state, &subject, None);
            assert!(
                state
                    .store
                    .pending_title(&parent)
                    .expect("pending")
                    .is_some()
            );
        }
        let service = Arc::new(service);
        let background = Arc::clone(&service);
        let watcher = tokio::spawn(async move { background.watch_host().await });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if service
                    .state
                    .lock()
                    .await
                    .store
                    .pending_title(&parent)
                    .expect("receipt")
                    .is_none()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await
        .expect("title confirmed");
        watcher.abort();
        native.abort();
    }
}
