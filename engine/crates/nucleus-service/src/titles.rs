//! Native titles are an independent presentation effect.

use std::time::Duration;

use nucleus_core::{Hold, HoldBy, Phase, Review, Role, Task, Verdict, WaitReason};
use nucleus_hosts::{HostError, INBOX_THREAD, InboxTarget, TitleTarget};
use nucleus_store::{DispatchMode, TaskRow, TitleReceipt};

use crate::{Service, ServiceError, State, WaitDetail, now_ms, pass::DispatchTarget, presentation};

const T3_TITLE_LIMIT: usize = 200;

pub(super) fn child_title(task: &Task, number: Option<i64>, role: Role) -> String {
    let prefix = match (number, role) {
        (Some(number), Role::Worker) => format!("#{number}: "),
        (Some(number), Role::Reviewer) => format!("#{number} review: "),
        (None, Role::Worker) => String::new(),
        (None, Role::Reviewer) => "Review: ".into(),
    };
    fit(&format!("{prefix}{}", brief(task)))
}

fn task_title(task: &Task, number: Option<i64>, label: &str) -> String {
    let number = number.map_or_else(String::new, |number| format!("#{number} "));
    fit(&format!("{label}: {number}{}", brief(task)))
}

// The compact taskTitleStateLabel rule serves both native titles and the board.
pub(super) fn task_state_label(
    task: &Task,
    wait: Option<WaitReason>,
    detail: Option<&WaitDetail>,
) -> String {
    if let Some(label) = task_label_from_facts(task) {
        return label;
    }
    if (wait.is_none() || (wait == Some(WaitReason::HostUnknown) && detail.is_none()))
        && task.run().is_some_and(|run| {
            !run.revoked() && run.report().is_none() && run.last_send_at_ms().is_none()
        })
    {
        return "Starting".into();
    }
    if let Some(label) = wait_label(wait, detail) {
        return label.into();
    }
    let phase = phase_label(task);
    if task.hold().is_some() {
        format!("{phase}*")
    } else {
        phase.into()
    }
}

pub(super) fn phase_label(task: &Task) -> &'static str {
    match task.phase() {
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
        Phase::ReportReady => "Report ready",
        Phase::Blocked => "Blocked",
        Phase::Error => "Error",
        Phase::Reviewing => "Reviewing",
        Phase::Merging => "Merging",
        Phase::Closing => "Closing",
        Phase::Done => "Done",
        Phase::Cancelled => "Cancelled",
    }
}

// These committed facts determine the label regardless of the scheduler wait.
pub(super) fn task_label_from_facts(task: &Task) -> Option<String> {
    let has_live_run = task.run().is_some_and(|run| {
        !run.revoked() && run.last_send_at_ms().is_some() && run.report().is_none()
    });
    Some(match task.phase() {
        Phase::Done | Phase::Cancelled => phase_label(task).into(),
        _ if task.run().is_some_and(nucleus_core::Run::revoked) => "Stopping".into(),
        _ if let Some(hold) = task.hold().filter(|_| !has_live_run) => {
            held_label(task.phase(), hold)
        }
        _ if task.operator_decline().is_some() => "Declined by Tom".into(),
        _ if task.operator_question().is_some() => "Waiting on Tom".into(),
        _ if task.question().is_some() => "Waiting for the planner".into(),
        _ => return None,
    })
}

fn held_label(phase: Phase, hold: &Hold) -> String {
    if let Some(target) = reference(&hold.reason) {
        return format!("Waiting on {target}");
    }
    match (phase, hold.by) {
        (Phase::Merging, Some(HoldBy::Operator)) => "Merge held by Tom",
        (Phase::Merging, Some(HoldBy::Planner)) => "Merge held by planner",
        (Phase::Merging, None) => "Merge held",
        (_, Some(HoldBy::Operator)) => "Waiting on Tom",
        (_, Some(HoldBy::Planner)) => "Held by planner",
        (_, None) => "Held",
    }
    .into()
}

fn wait_label(wait: Option<WaitReason>, detail: Option<&WaitDetail>) -> Option<&'static str> {
    Some(match wait {
        Some(WaitReason::Question) => "Waiting for the planner",
        Some(WaitReason::Capacity) => "Waiting for capacity",
        Some(WaitReason::Prerequisite) => "Waiting for prerequisite",
        Some(WaitReason::HostObservationBlocked) => "Couldn’t verify task thread",
        Some(WaitReason::UsagePermission) => "Waiting on Tom",
        Some(WaitReason::HostUnknown) => match detail {
            Some(WaitDetail::OperatorSnoozed { .. }) => "You snoozed this thread",
            Some(
                WaitDetail::BeforeSend(None)
                | WaitDetail::ShowingForDelivery(None)
                | WaitDetail::ConfirmingDelivery(_),
            ) => "Starting",
            _ => "Waiting for T3",
        },
        Some(WaitReason::IdleWithoutTerminalRun) => "Checking turn outcome",
        Some(WaitReason::Permission) => "Waiting for permission",
        Some(WaitReason::Input) => "Waiting for input",
        Some(WaitReason::RetainedThreadBusy) => "Waiting for the previous turn",
        Some(WaitReason::ForgeUnknown) => "Waiting for GitHub",
        Some(WaitReason::ReviewPublicationBlocked) => "Review needs attention",
        Some(WaitReason::WorkspaceUnknown) => "Checking the workspace",
        Some(WaitReason::WorkspaceBlocked) => "Workspace needs attention",
        Some(WaitReason::ChecksPending) => "Waiting for checks",
        Some(WaitReason::ChecksUnreported) => "Waiting for required checks to report",
        Some(WaitReason::AssignmentTooLarge) => "Assignment too large",
        Some(WaitReason::Starting) => "Starting",
        _ => return None,
    })
}

pub(super) fn brief(task: &Task) -> String {
    let flat = brief_title(task);
    flat.rsplit_once(' ')
        .filter(|(_, last)| last.eq_ignore_ascii_case("worker"))
        .map_or(flat.as_str(), |(title, _)| title)
        .to_owned()
}

pub(super) fn brief_title(task: &Task) -> String {
    let text = task
        .brief()
        .declared_title()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| presentation::brief_title(&task.brief().text).map(str::to_owned))
        .unwrap_or_else(|| "Task".into());
    text.split_whitespace().collect::<Vec<_>>().join(" ")
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

fn inbox_title(decisions: usize, running: usize, mode: DispatchMode) -> String {
    let prefix = if mode == DispatchMode::Running {
        ""
    } else {
        "Paused: "
    };
    let status = if decisions > 0 {
        let noun = if decisions == 1 {
            "decision"
        } else {
            "decisions"
        };
        format!("{decisions} {noun} to answer")
    } else if running > 0 {
        let noun = if running == 1 { "task" } else { "tasks" };
        format!("{running} {noun} running")
    } else {
        "All quiet".into()
    };
    format!("{prefix}{status}")
}

impl Service {
    pub(super) fn desire_title(&self, state: &State, task: &Task, number: Option<i64>) {
        if self.acp_provider().is_none() {
            return;
        }
        let id = &task.identity().id;
        let label = match state.effective_wait(task) {
            Ok(wait) => task_state_label(task, wait, state.wait_detail(id)),
            Err(error) => {
                eprintln!("{id}: {error}");
                return;
            }
        };
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &task.identity().repository,
            id,
        );
        let thread = nucleus_hosts::parent_thread(&path);
        match state
            .store
            .desire_title(id, &thread, &task_title(task, number, &label))
        {
            Ok(true) => self.title_wake.notify_one(),
            Ok(false) => {}
            Err(error) => eprintln!("{id}: {error}"),
        }
    }

    pub(super) async fn watch_titles(&self) {
        let Some(provider) = self.acp_provider() else {
            return;
        };
        {
            let state = self.state.lock().await;
            match state.store.tasks_without_titles() {
                Ok(rows) => {
                    for row in rows
                        .into_iter()
                        .filter(|row| self.task_scope(row.task.identity()).is_ok())
                    {
                        self.desire_title(&state, &row.task, row.number);
                    }
                }
                Err(error) => eprintln!("{error}"),
            }
        }
        loop {
            self.host.wait_for_requests().await;
            let threads = self.host.title_threads(provider);
            let next = self.title_work(provider, &threads).await;
            let wait = match next {
                Ok(Some(receipt)) => {
                    let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
                    if receipt.retry_at > now {
                        Some(Duration::from_millis(receipt.retry_at.abs_diff(now)))
                    } else {
                        if let Err(error) = self.apply_title(provider, &receipt, now).await {
                            eprintln!("{}: {error}", receipt.thread);
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
            let row_wait = match self.reconcile_task_rows(provider, &threads).await {
                Ok(wait) => wait,
                Err(error) => {
                    eprintln!("{error}");
                    Some(Duration::from_secs(15))
                }
            };
            let wait = wait.into_iter().chain(row_wait).min();
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
        provider: &str,
        threads: &[String],
    ) -> Result<Option<TitleReceipt>, ServiceError> {
        let state = self.state.lock().await;
        let mut earliest: Option<TitleReceipt> = None;
        for thread in threads {
            let candidate = if thread == INBOX_THREAD {
                self.inbox_title_work(&state, provider)?
            } else {
                state.store.pending_title(thread)?
            };
            if let Some(receipt) = candidate
                && earliest
                    .as_ref()
                    .is_none_or(|prior| receipt.retry_at < prior.retry_at)
            {
                earliest = Some(receipt);
            }
        }
        Ok(earliest)
    }

    fn inbox_title_target(&self, provider: &str) -> Option<TitleTarget> {
        let inbox = self.native_inbox.as_ref()?;
        self.host.inbox_title_target(&InboxTarget {
            provider,
            root: &inbox.root,
        })
    }

    fn inbox_title_work(
        &self,
        state: &State,
        provider: &str,
    ) -> Result<Option<TitleReceipt>, ServiceError> {
        if self.inbox_title_target(provider).is_none() {
            return Ok(None);
        }
        let decisions = crate::native_inbox::pending(state, self)?.len();
        let running = state
            .waits
            .values()
            .filter(|wait| wait.reason == Some(WaitReason::Running))
            .count();
        let mode = state
            .settings
            .dispatch
            .as_ref()
            .map_or(DispatchMode::Running, |dispatch| dispatch.mode);
        state
            .store
            .desire_inbox_title(INBOX_THREAD, &inbox_title(decisions, running, mode))?;
        Ok(state.store.pending_inbox_title(INBOX_THREAD)?)
    }

    async fn apply_title(
        &self,
        provider: &str,
        receipt: &TitleReceipt,
        now: i64,
    ) -> Result<(), ServiceError> {
        let applied = if let Some(task_id) = receipt.task_id.as_deref() {
            self.write_task_title(provider, task_id, receipt).await
        } else {
            self.write_inbox_title(provider, receipt).await
        };
        self.finish_title(receipt, now, applied).await
    }

    async fn finish_title(
        &self,
        receipt: &TitleReceipt,
        now: i64,
        applied: Result<bool, ServiceError>,
    ) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        match applied {
            Ok(true) => state.store.confirm_title(receipt)?,
            Err(ServiceError::Host(HostError::Deferred { .. })) => {}
            _ => {
                state.store.defer_title(receipt, now)?;
            }
        }
        applied.map(|_| ())
    }

    async fn write_inbox_title(
        &self,
        provider: &str,
        receipt: &TitleReceipt,
    ) -> Result<bool, ServiceError> {
        let Some(target) = self.inbox_title_target(provider) else {
            return Ok(false);
        };
        if target.current_title() != Some(&receipt.desired) {
            let key = format!("nucleus-rust-inbox-title-{}", receipt.generation);
            self.host
                .write_title(target, &key, &receipt.desired)
                .await?;
        }
        Ok(true)
    }

    async fn write_task_title(
        &self,
        provider: &str,
        task_id: &str,
        receipt: &TitleReceipt,
    ) -> Result<bool, ServiceError> {
        let row = self.task(task_id).await?;
        let fence = self.task_fence(task_id).await;
        let Ok(_guard) = fence.try_lock_owned() else {
            return Ok(false);
        };
        if !self.title_current(&row, receipt).await? {
            return Ok(false);
        }
        let identity = row.task.identity();
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(&route.checkout, &identity.repository, task_id)?;
        let binding = route.binding(&checkout)?;
        let Some(target) = route
            .checkout
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
            .filter(|target| target.thread() == receipt.thread)
        else {
            return Ok(false);
        };
        if target.current_title() == Some(&receipt.desired) {
            return Ok(true);
        }
        let destination = DispatchTarget::Presentation {
            frozen: target.binding().ok_or(ServiceError::AcpBinding)?,
            checkout: &checkout,
        };
        let Some(_permit) = self.dispatch_gate(&row.task, destination).await? else {
            return Ok(false);
        };
        self.write_task_title_target(target, task_id, receipt).await
    }

    async fn write_task_title_target(
        &self,
        target: TitleTarget,
        task_id: &str,
        receipt: &TitleReceipt,
    ) -> Result<bool, ServiceError> {
        if target.current_title() == Some(&receipt.desired) {
            return Ok(true);
        }
        let key = format!("task-{task_id}-title-{}", receipt.generation);
        self.host
            .write_title(target, &key, &receipt.desired)
            .await?;
        Ok(true)
    }

    /// Try the existing title receipt while the role admission holds both fences.
    pub(super) async fn reflect_role_admission(
        &self,
        row: &TaskRow,
        checkout: &nucleus_work::Checkout<'_>,
        provider: &str,
    ) -> Result<(), ServiceError> {
        let identity = row.task.identity();
        let binding = self.project_for(identity).await?.binding(checkout)?;
        let Some(target) = checkout
            .repository()
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
        else {
            return Ok(());
        };
        let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
        let receipt = self
            .state
            .lock()
            .await
            .store
            .pending_title(target.thread())?;
        if let Some(receipt) = receipt.filter(|receipt| receipt.retry_at <= now) {
            let result = self
                .write_task_title_target(target, &identity.id, &receipt)
                .await;
            self.finish_title(&receipt, now, result).await?;
        }
        Ok(())
    }

    async fn title_current(
        &self,
        expected: &TaskRow,
        receipt: &TitleReceipt,
    ) -> Result<bool, ServiceError> {
        let state = self.state.lock().await;
        let current = self.lookup(&state, &expected.task.identity().id)?;
        Ok(current.version == expected.version
            && state
                .store
                .pending_title(&receipt.thread)?
                .is_some_and(|pending| pending.generation == receipt.generation))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

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
            child_title(&task, Some(1), Role::Worker),
            "#1: Add a greeting"
        );
        assert_eq!(
            child_title(&task, Some(1), Role::Reviewer),
            "#1 review: Add a greeting"
        );
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(&task, Some(WaitReason::Capacity), None)
            ),
            "Waiting for capacity: #1 Add a greeting"
        );
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(
                    &task,
                    Some(WaitReason::HostUnknown),
                    Some(&WaitDetail::ShowingForDelivery(None))
                )
            ),
            "Starting: #1 Add a greeting"
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
            task_title(
                &task,
                Some(1),
                &task_state_label(&task, Some(WaitReason::Hold), None)
            ),
            "Waiting on fixture#2: #1 Add a greeting"
        );
        task.command(Command::Hold("Wait for copy".into()), &authority, &obs)
            .expect("hold");
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(&task, Some(WaitReason::Hold), None)
            ),
            "Held by planner: #1 Add a greeting"
        );
        task.command(Command::Cancel, &authority, &obs)
            .expect("cancel");
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(&task, Some(WaitReason::Stopping), None)
            ),
            "Cancelled: #1 Add a greeting"
        );
        let prefix = "🔬 ".repeat(66);
        assert_eq!(
            fit(&format!("{prefix}word")),
            format!("{}…", prefix.trim_end())
        );
    }

    fn inbox_choice() -> nucleus_store::planning::DecisionInput {
        use nucleus_store::planning::{DecisionInput, DecisionOption};
        DecisionInput {
            question: "Continue?".into(),
            options: ["yes", "no"]
                .into_iter()
                .map(|choice| DecisionOption {
                    id: choice.into(),
                    label: choice.into(),
                })
                .collect(),
        }
    }

    #[tokio::test]
    async fn inbox_status_titles_only_write_changed_metadata_under_a_fresh_generation() {
        use nucleus_store::planning::WriteAt;

        let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
        let provider = "fixture-acp";
        service.fixture_mut().acp_provider = Some(provider.into());
        service.native_inbox = Some(crate::native_inbox::NativeInbox::open(&service).unwrap());
        let root = &service.native_inbox.as_ref().unwrap().root;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let (host, server) = native_fixture(move |req| {
            assert_eq!(req["tag"], "orchestration.dispatchCommand");
            assert_eq!(req["payload"]["type"], "thread.metadata.update");
            assert_eq!(req["payload"]["threadId"], INBOX_THREAD);
            seen.lock().unwrap().push(req["payload"].clone());
            json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
        })
        .await;
        let shell = |title| {
            json!({"projects":[{"id":"project:nucleus-rust-inbox","workspaceRoot":root}],
            "threads":[{"id":INBOX_THREAD,"projectId":"project:nucleus-rust-inbox",
            "providerInstanceId":provider,"worktreePath":null,"title":title,"pinnedAt":"now"}]})
        };
        host.fixture_project_shell(&shell("All quiet"), provider);
        service.host = host;
        let inbox = [INBOX_THREAD.to_owned()];
        let first = service.title_work(provider, &inbox).await.unwrap().unwrap();
        service.apply_title(provider, &first, 0).await.unwrap();
        assert!(requests.lock().unwrap().is_empty());

        service
            .state
            .lock()
            .await
            .set_wait("fixture", Some(WaitReason::Running));
        let running = service.title_work(provider, &inbox).await.unwrap().unwrap();
        service.apply_title(provider, &running, 0).await.unwrap();
        assert_eq!(running.desired, "1 task running");
        assert!(
            service
                .title_work(provider, &inbox)
                .await
                .unwrap()
                .is_none()
        );
        service
            .host
            .fixture_project_shell(&shell("1 task running"), provider);

        let project = service.fixture().host_project.clone();
        let stamp = |actor, at_ms| WriteAt { actor, at_ms };
        {
            let mut state = service.state.lock().await;
            state
                .settings
                .dispatch
                .get_or_insert_with(Default::default)
                .mode = DispatchMode::Held;
            state
                .store
                .add_decision(
                    &project,
                    "test-decision".into(),
                    inbox_choice(),
                    stamp("planner", 0),
                )
                .unwrap();
        }
        let decision = service.title_work(provider, &inbox).await.unwrap().unwrap();
        service.apply_title(provider, &decision, 0).await.unwrap();
        assert_eq!(decision.desired, "Paused: 1 decision to answer");
        service
            .host
            .fixture_project_shell(&shell(&decision.desired), provider);
        {
            let mut state = service.state.lock().await;
            state.set_wait("fixture", None);
            state.settings.dispatch = None;
            state
                .store
                .answer_decision(
                    &project,
                    "test-decision",
                    nucleus_store::planning::DecisionAnswerInput {
                        option_id: "yes".into(),
                        note: None,
                    },
                    stamp("operator", 1),
                )
                .unwrap();
        }
        let quiet = service.title_work(provider, &inbox).await.unwrap().unwrap();
        assert_eq!(quiet.desired, first.desired);
        service.apply_title(provider, &quiet, 0).await.unwrap();
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .map(|payload| payload["commandId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            [2, 3, 4].map(|generation| format!("nucleus-rust-inbox-title-{generation}"))
        );
        server.abort();
    }

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "keep the live shell and title receipt round trip in one fixture"
    )]
    async fn native_title_changes_once_and_idle_reconciliation_makes_no_writes() {
        let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
        let task = task();
        let mut subject = Task::new(
            Identity {
                repository: service.fixture().repository.clone(),
                ..task.identity().clone()
            },
            task.brief().text.clone(),
            None,
        );
        assert!(subject.ask_allowance(1, 1));
        let id = &subject.identity().id;
        let worktrees = service.worktrees().expect("fixture worktrees");
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                id,
            )
            .expect("checkout");
        checkout
            .allocate(&service.fixture().start)
            .expect("allocate");
        let binding = service.binding(&checkout).expect("workspace binding");
        let parent = nucleus_hosts::parent_thread(checkout.path());
        let root = service.fixture().checkout.clone();
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
            Some("subscribeServerConfig") => {
                json!({"_tag":"Chunk","requestId":req["id"],"values":[]})
            }
            Some("orchestration.dispatchCommand") => {
                assert_eq!(
                    req["payload"],
                    json!({"type":"thread.metadata.update","threadId":expected,
                    "commandId":"task-fixture-title-1","title":"Waiting for the planner: #1 Add a greeting"})
                );
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            }
            _ => panic!("title work must not read any other host state"),
        })
        .await;
        service.host = host;
        service.fixture_mut().acp_provider = Some("fixture-acp".into());
        {
            let mut state = service.state.lock().await;
            state
                .store
                .create(&subject, &event("admitted"))
                .expect("seed task");
            let row = service
                .lookup(&state, &subject.identity().id)
                .expect("task");
            service.desire_title(&state, &row.task, row.number);
            assert!(
                state
                    .store
                    .pending_title(&parent)
                    .expect("pending")
                    .is_some()
            );
        }
        {
            let mut watcher = std::pin::pin!(service.watch_host());
            std::future::poll_fn(|cx| {
                assert!(watcher.as_mut().poll(cx).is_pending());
                // The watcher's own wakeups drive the receipt check through durable confirmation.
                let confirmed = service.state.try_lock().is_ok_and(|state| {
                    state
                        .store
                        .pending_title(&parent)
                        .expect("receipt")
                        .is_none()
                });
                if confirmed {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            })
            .await;
        }
        let counts = service.host.host_calls();
        assert_eq!(counts["orchestration.subscribeShell"], 1);
        assert_eq!(counts["orchestration.dispatchCommand"], 1);
        assert!(!counts.contains_key("orchestration.subscribeThread"));
        {
            let state = service.state.lock().await;
            let row = service.lookup(&state, id).unwrap();
            service.desire_title(&state, &row.task, row.number);
        }
        assert!(
            service
                .title_work("fixture-acp", &[parent])
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            service.host.host_calls()["orchestration.dispatchCommand"],
            1
        );
        native.abort();
    }
}
