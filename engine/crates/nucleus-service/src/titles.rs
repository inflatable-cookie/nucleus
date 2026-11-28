//! Native titles are an independent presentation effect.

use std::time::Duration;

use nucleus_core::{Hold, HoldBy, Phase, Review, Role, Task, Verdict, WaitReason};
use nucleus_hosts::{HostError, INBOX_THREAD, InboxTarget, TitleTarget};
use nucleus_store::{DispatchMode, StoredTitle, TaskRow, TitleReceipt};
use tokio::time::Instant;

use crate::{Service, ServiceError, State, WaitDetail, now_ms, pass::DispatchTarget, presentation};

const T3_TITLE_LIMIT: usize = 200;
const TITLE_STABILITY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
enum TitleTiming {
    Immediate,
    Stable,
}

pub(super) struct TitleCandidate {
    task_id: Option<String>,
    text: String,
    pub(super) ready: Instant,
}

impl State {
    fn title_ready(
        &mut self,
        thread: &str,
        task_id: Option<&str>,
        text: &str,
        timing: TitleTiming,
        desired: Option<&str>,
    ) -> bool {
        if desired == Some(text) {
            self.title_candidates.remove(thread);
            return false;
        }
        if timing == TitleTiming::Immediate {
            return true;
        }
        let now = Instant::now();
        let candidate = self
            .title_candidates
            .entry(thread.to_owned())
            .or_insert_with(|| TitleCandidate {
                task_id: task_id.map(str::to_owned),
                text: text.to_owned(),
                ready: now + TITLE_STABILITY,
            });
        if candidate.text != text {
            text.clone_into(&mut candidate.text);
            candidate.ready = now + TITLE_STABILITY;
        }
        candidate.ready <= now
    }
}

impl State {
    pub(super) fn prerequisite_detail(
        &self,
        task: &Task,
    ) -> Result<Option<String>, nucleus_store::StoreError> {
        let dependencies = self.store.dependencies(&task.identity().id)?;
        let (ids, reason) = if let Some(wait) = dependencies
            .wait
            .filter(|wait| wait.released_at_ms.is_none())
        {
            (wait.ids, Some(wait.reason))
        } else {
            (dependencies.before_dispatch, None)
        };
        let mut refs = Vec::new();
        for id in ids {
            match self.store.row(&id) {
                Ok(Some(row)) => refs.push(row.reference().into_owned()),
                Err(nucleus_store::StoreError::UnreadableTask(row)) => refs.push(row.reference),
                Ok(None) => refs.push(id),
                Err(error) => return Err(error),
            }
        }
        if refs.is_empty() {
            return Ok(reason);
        }
        let refs = refs.join(", ");
        Ok(Some(reason.map_or_else(
            || format!("Waiting for {refs}"),
            |reason| format!("{reason} ({refs})"),
        )))
    }

    pub(super) fn display_state_label(
        &self,
        task: &Task,
        wait: Option<WaitReason>,
        detail: Option<&WaitDetail>,
    ) -> Result<String, nucleus_store::StoreError> {
        let mut refs = Vec::new();
        if wait == Some(WaitReason::Prerequisite) && task.phase() != Phase::Queued {
            let dependencies = self.store.dependencies(&task.identity().id)?;
            let mut ids = Vec::new();
            if task.threads().get(Role::Worker).is_none()
                && task.threads().get(Role::Reviewer).is_none()
            {
                ids.extend(dependencies.before_dispatch);
            }
            if let Some(gate) = dependencies
                .wait
                .filter(|gate| gate.released_at_ms.is_none())
            {
                ids.extend(gate.ids);
            }
            for id in ids {
                if let Some(row) = self.store.row(&id)?
                    && row.task.phase() != Phase::Done
                {
                    refs.push(row.reference().into_owned());
                }
            }
        }
        let prerequisites = WaitDetail::Prerequisites(refs);
        let detail = if matches!(&prerequisites, WaitDetail::Prerequisites(refs) if !refs.is_empty())
        {
            Some(&prerequisites)
        } else {
            detail
        };
        Ok(task_state_label(task, wait, detail))
    }
}

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
    if live_role(task) {
        return phase_with_delay(task, None);
    }
    if let Some(label) = task_label_from_facts(task) {
        return label;
    }
    if wait == Some(WaitReason::MergeHold)
        && let Some(hold) = task.merge_hold()
    {
        return match hold.by {
            Some(HoldBy::Operator) => "Merge held by operator",
            _ => "Merge held by planner",
        }
        .into();
    }
    if wait == Some(WaitReason::Capacity)
        && let Some(WaitDetail::SlotCap(label)) = detail
    {
        return label.clone();
    }
    if task.phase() != Phase::Queued {
        match (wait, detail) {
            (Some(WaitReason::Prerequisite), Some(WaitDetail::Prerequisites(refs)))
                if !refs.is_empty() =>
            {
                let first = refs[0]
                    .rsplit_once('#')
                    .map_or(refs[0].as_str(), |(_, number)| number);
                let extra = if refs.len() > 1 {
                    format!(" +{}", refs.len() - 1)
                } else {
                    String::new()
                };
                return format!("Waiting for #{first}{extra}");
            }
            (Some(WaitReason::Capacity), Some(WaitDetail::Blocked(cause))) => {
                if let Some(group) =
                    cause
                        .strip_prefix("Paused: subscription group ")
                        .and_then(|s| {
                            s.split_once(" resets at ")
                                .map(|(group, _)| group)
                                .or_else(|| s.strip_suffix(". Resume it in Profiles."))
                        })
                {
                    return format!("Paused · {group}");
                }
            }
            (Some(WaitReason::Capacity), _) => return "Waiting for a slot".into(),
            (Some(WaitReason::Starting | WaitReason::HostUnknown), _) => return "Starting".into(),
            _ => {}
        }
    }
    // A capacity wait that carries a cause is a paused subscription group (ruling 51).
    if wait == Some(WaitReason::Capacity) && matches!(detail, Some(WaitDetail::Blocked(_))) {
        return phase_with_delay(task, Some("paused"));
    }
    if task.phase() == Phase::Reviewing
        && wait == Some(WaitReason::ForgeUnknown)
        && matches!(detail, Some(WaitDetail::ConfirmingDelivery(_)))
    {
        return phase_with_delay(task, Some("confirming review"));
    }
    phase_with_delay(task, wait_label(task, wait))
}

fn live_role(task: &Task) -> bool {
    task.run().is_some_and(|run| {
        !run.revoked() && run.last_send_at_ms().is_some() && run.report().is_none()
    })
}

fn phase_with_delay(task: &Task, delay: Option<&str>) -> String {
    let mut label = phase_label(task).to_owned();
    if task.hold().is_some() && live_role(task) {
        label.push('*');
    }
    if let Some(delay) = delay {
        label.push_str(" · ");
        label.push_str(delay);
    }
    label
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
    let delay = match task.phase() {
        Phase::Done | Phase::Cancelled => return Some(phase_label(task).into()),
        _ if task.run().is_some_and(nucleus_core::Run::revoked) => "stopping",
        _ if let Some(hold) = task.hold().filter(|_| !live_role(task)) => {
            if task.phase() != Phase::Queued {
                return Some(
                    match hold.by {
                        Some(HoldBy::Operator) => "Held by operator",
                        _ => "Held by planner",
                    }
                    .into(),
                );
            }
            held_label(hold)
        }
        _ if task.operator_decline().is_some() => "declined",
        _ if task.operator_question().is_some() => "Tom",
        _ if task.question().is_some() => "planner",
        _ => return None,
    };
    Some(phase_with_delay(task, Some(delay)))
}

fn held_label(hold: &Hold) -> &str {
    reference(&hold.reason).unwrap_or(match hold.by {
        Some(HoldBy::Operator) => "Tom",
        Some(HoldBy::Planner) => "planner",
        None => "held",
    })
}

fn wait_label(task: &Task, wait: Option<WaitReason>) -> Option<&'static str> {
    Some(match wait {
        Some(WaitReason::Starting) if live_role(task) => "starting",
        Some(WaitReason::Starting | WaitReason::HostUnknown) => "T3",
        Some(WaitReason::Question) => "planner",
        Some(WaitReason::Capacity) => "capacity",
        Some(WaitReason::Prerequisite) => "prerequisite",
        Some(WaitReason::HostObservationBlocked) => "unverified",
        Some(WaitReason::UsagePermission) => "Tom",
        Some(WaitReason::IdleWithoutTerminalRun) => "turn",
        Some(WaitReason::Permission) => "permission",
        Some(WaitReason::Input) => "input",
        Some(WaitReason::ForgeUnknown) => "GitHub",
        Some(WaitReason::ExternalMergeBlocked) => "source",
        Some(WaitReason::ReviewPublicationBlocked) => "publication",
        Some(WaitReason::WorkspaceUnknown | WaitReason::WorkspaceBlocked) => "workspace",
        Some(WaitReason::ChecksPending) => "checks",
        Some(WaitReason::AssignmentTooLarge) => "size",
        Some(WaitReason::Stopping) => "stopping",
        Some(WaitReason::EngineBlocked) => "blocked",
        Some(WaitReason::OperatorDeclined) => "declined",
        Some(WaitReason::Running | WaitReason::Hold | WaitReason::MergeHold) | None => return None,
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
        .or_else(|| task.papercut_title.clone())
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

enum TitleOutcome {
    Confirmed,
    Pending,
    Stale,
}

fn reconcile_stored_title(
    state: &State,
    target: Option<&TitleTarget>,
    stored: StoredTitle,
) -> Result<Option<TitleReceipt>, ServiceError> {
    let matched = target
        .and_then(TitleTarget::current_title)
        .is_some_and(|shown| shown == stored.receipt.desired);
    if stored.confirmed {
        // A confirmed generation whose held shell still displays older wording
        // re-desires under the same command ID while preserving newer generations.
        if target.is_some() && !matched && state.store.redesire_title(&stored.receipt)? {
            return Ok(state.store.pending_for_receipt(&stored.receipt)?);
        }
        return Ok(None);
    }
    if matched {
        state.store.confirm_title(&stored.receipt)?;
        return Ok(None);
    }
    Ok(Some(stored.receipt))
}

impl Service {
    pub(super) fn desire_title(&self, state: &mut State, task: &Task, number: Option<i64>) -> bool {
        self.desire_task_title(state, task, number, TitleTiming::Stable)
    }

    pub(super) fn desire_phase_title(&self, state: &mut State, task: &Task, number: Option<i64>) {
        self.desire_task_title(state, task, number, TitleTiming::Immediate);
    }

    fn desire_task_title(
        &self,
        state: &mut State,
        task: &Task,
        number: Option<i64>,
        timing: TitleTiming,
    ) -> bool {
        if self.acp_provider().is_none() {
            return false;
        }
        let id = &task.identity().id;
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &task.identity().repository,
            id,
        );
        let thread = nucleus_hosts::parent_thread(&path);
        let desired = self.stage_task_title(state, task, number, &thread, timing);
        match desired {
            Ok(true) => {
                self.title_wake.notify_one();
                true
            }
            Ok(false) => false,
            Err(error) => {
                service_log!("{id}: {error}");
                false
            }
        }
    }

    fn stage_task_title(
        &self,
        state: &mut State,
        task: &Task,
        number: Option<i64>,
        thread: &str,
        timing: TitleTiming,
    ) -> Result<bool, nucleus_store::StoreError> {
        let stored = state.store.title_state(thread)?;
        let desired = stored.as_ref().map(|title| title.receipt.desired.as_str());
        let (label, timing) = self.row_label(state, task, thread, timing)?;
        let id = &task.identity().id;
        let text = task_title(task, number, &label);
        let timing = if desired.is_none() {
            TitleTiming::Immediate
        } else {
            timing
        };
        let prior_deadline = state
            .title_candidates
            .get(thread)
            .map(|candidate| candidate.ready);
        if state.title_ready(thread, Some(id), &text, timing, desired) {
            let changed = state.store.desire_title(id, thread, &text)?;
            state.title_candidates.remove(thread);
            return Ok(changed);
        }
        let deadline = state
            .title_candidates
            .get(thread)
            .map(|candidate| candidate.ready);
        Ok(deadline != prior_deadline)
    }

    fn row_label(
        &self,
        state: &State,
        task: &Task,
        thread: &str,
        timing: TitleTiming,
    ) -> Result<(String, TitleTiming), nucleus_store::StoreError> {
        if let Some(label) = task_label_from_facts(task) {
            return Ok((label, TitleTiming::Immediate));
        }
        let id = &task.identity().id;
        // Slot counts belong on the board; changing counts must not rename T3 rows.
        let detail = state
            .wait_detail(id)
            .filter(|detail| !matches!(detail, WaitDetail::SlotCap(_)));
        let (activity, _, handover) = self.role_window(thread, task);
        let wait = state.effective_wait(task)?.filter(|reason| {
            *reason != WaitReason::Starting || activity != nucleus_hosts::RowChildren::Active
        });
        let person_needed = crate::attention::waiting_for_person(task, wait);
        let timing = if person_needed
            || matches!(
                wait,
                Some(WaitReason::HostObservationBlocked | WaitReason::AssignmentTooLarge)
            ) {
            TitleTiming::Immediate
        } else {
            timing
        };
        let snoozed = self
            .host
            .row_visibility_hint(thread)
            .and_then(|row| row.snoozed_until_ms)
            .is_some_and(|until| until > self.visibility_now());
        let label = if !person_needed && !snoozed && handover.is_some() {
            "Waiting".into()
        } else {
            state.display_state_label(task, wait, detail)?
        };
        Ok((label, timing))
    }

    pub(super) async fn watch_titles(&self) {
        // Planner notices can need snooze restoration without an ACP provider.
        let provider = self.acp_provider();
        if provider.is_some() {
            let mut state = self.state.lock().await;
            match state.store.tasks_without_titles() {
                Ok(rows) => {
                    for row in rows
                        .into_iter()
                        .filter(|row| self.task_scope(row.task.identity()).is_ok())
                    {
                        self.desire_title(&mut state, &row.task, row.number);
                    }
                }
                Err(error) => service_log!("{error}"),
            }
        }
        loop {
            self.host.wait_for_requests().await;
            let threads =
                provider.map_or_else(Vec::new, |provider| self.host.title_threads(provider));
            let next = match provider {
                Some(provider) => self.title_work(provider, &threads).await,
                None => Ok(None),
            };
            let checked_stability = next.is_ok();
            let wait = match next {
                Ok(Some(receipt)) => {
                    let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
                    if receipt.retry_at > now {
                        Some(Duration::from_millis(receipt.retry_at.abs_diff(now)))
                    } else {
                        if let Err(error) = self
                            .apply_title(provider.unwrap_or_default(), &receipt, now)
                            .await
                        {
                            service_log!("{}: {error}", receipt.thread);
                        }
                        // The next due candidate can run before this title retries.
                        continue;
                    }
                }
                Ok(None) => None,
                Err(error) => {
                    service_log!("{error}");
                    Some(Duration::from_secs(5))
                }
            };
            let row_wait = match self
                .reconcile_task_rows(provider.unwrap_or_default(), &threads)
                .await
            {
                Ok(wait) => wait,
                Err(error) => {
                    service_log!("{error}");
                    Some(Duration::from_secs(15))
                }
            };
            let stability_wait = if checked_stability {
                let state = self.state.lock().await;
                threads
                    .iter()
                    .filter_map(|thread| state.title_candidates.get(thread))
                    .map(|candidate| candidate.ready.saturating_duration_since(Instant::now()))
                    .min()
            } else {
                None
            };
            let wait = wait.into_iter().chain(row_wait).chain(stability_wait).min();
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
        let mut state = self.state.lock().await;
        let mut earliest: Option<TitleReceipt> = None;
        for thread in threads {
            let candidate = if thread == INBOX_THREAD {
                self.inbox_title_work(&mut state, provider)?
            } else {
                if let Some(id) = state
                    .title_candidates
                    .get(thread)
                    .filter(|candidate| candidate.ready <= Instant::now())
                    .and_then(|candidate| candidate.task_id.clone())
                {
                    let row = self.lookup(&state, &id)?;
                    self.stage_task_title(
                        &mut state,
                        &row.task,
                        row.number,
                        thread,
                        TitleTiming::Stable,
                    )?;
                }
                if let Some(stored) = state.store.title_state(thread)? {
                    let target = stored
                        .receipt
                        .task_id
                        .as_deref()
                        .and_then(|task_id| self.lookup(&state, task_id).ok())
                        .and_then(|row| {
                            self.task_title_target_with_state(&state, &row.task, provider, thread)
                                .ok()
                                .flatten()
                        });
                    reconcile_stored_title(&state, target.as_ref(), stored)?
                } else {
                    None
                }
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

    fn task_title_target_with_state(
        &self,
        state: &State,
        task: &Task,
        provider: &str,
        thread: &str,
    ) -> Result<Option<TitleTarget>, ServiceError> {
        let identity = task.identity();
        let route = self.resolve_project(state, identity)?;
        // The state lock is held here, so this touches no checkout.
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        let binding = route.thread_binding(&path, &format!("ns-{}", identity.id))?;
        Ok(route
            .checkout
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
            .filter(|target| target.thread() == thread))
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
        state: &mut State,
        provider: &str,
    ) -> Result<Option<TitleReceipt>, ServiceError> {
        let Some(target) = self.inbox_title_target(provider) else {
            state.title_candidates.remove(INBOX_THREAD);
            return Ok(None);
        };
        let decisions = crate::native_inbox::pending(state, self)?.len();
        let running = if decisions == 0 {
            self.working_row_count(state)?
        } else {
            0
        };
        let mode = state
            .settings
            .dispatch
            .as_ref()
            .map_or(DispatchMode::Running, |dispatch| dispatch.mode);
        let text = inbox_title(decisions, running, mode);
        let mut stored = state.store.inbox_title_state(INBOX_THREAD)?;
        let desired = stored.as_ref().map(|title| title.receipt.desired.as_str());
        let shown = target.current_title();
        let timing = if decisions > 0
            || shown == Some(text.as_str())
            || desired.or(shown).is_some_and(|title| {
                title.starts_with("Paused: ") != (mode != DispatchMode::Running)
            }) {
            TitleTiming::Immediate
        } else {
            TitleTiming::Stable
        };
        if state.title_ready(INBOX_THREAD, None, &text, timing, desired) {
            state.store.desire_inbox_title(INBOX_THREAD, &text)?;
            state.title_candidates.remove(INBOX_THREAD);
            stored = state.store.inbox_title_state(INBOX_THREAD)?;
        }
        let Some(stored) = stored else {
            return Ok(None);
        };
        reconcile_stored_title(state, Some(&target), stored)
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
        applied: Result<TitleOutcome, ServiceError>,
    ) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        match applied {
            Ok(TitleOutcome::Confirmed) => state.store.confirm_title(receipt)?,
            Ok(TitleOutcome::Stale) | Err(ServiceError::Host(HostError::Deferred { .. })) => {}
            Ok(TitleOutcome::Pending) | Err(_) => {
                state.store.defer_title(receipt, now)?;
            }
        }
        applied.map(|_| ())
    }

    async fn write_inbox_title(
        &self,
        provider: &str,
        receipt: &TitleReceipt,
    ) -> Result<TitleOutcome, ServiceError> {
        let Some(target) = self.inbox_title_target(provider) else {
            return Ok(TitleOutcome::Pending);
        };
        let key = format!("nucleus-rust-inbox-title-{}", receipt.generation);
        if self
            .host
            .write_title(target, &key, &receipt.desired)
            .await?
        {
            Ok(TitleOutcome::Confirmed)
        } else {
            Ok(TitleOutcome::Pending)
        }
    }

    async fn write_task_title(
        &self,
        provider: &str,
        task_id: &str,
        receipt: &TitleReceipt,
    ) -> Result<TitleOutcome, ServiceError> {
        let row = self.task(task_id).await?;
        let fence = self.task_fence(task_id).await;
        let Ok(_guard) = fence.try_lock_owned() else {
            return Ok(TitleOutcome::Pending);
        };
        if !self.title_current(&row, receipt).await? {
            return Ok(TitleOutcome::Stale);
        }
        let identity = row.task.identity();
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, task_id)?;
        let binding = route.binding(&checkout)?;
        let Some(target) = route
            .checkout
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
            .filter(|target| target.thread() == receipt.thread)
        else {
            return Ok(TitleOutcome::Pending);
        };
        if target.current_title() == Some(&receipt.desired) {
            return Ok(TitleOutcome::Confirmed);
        }
        let destination = DispatchTarget::Presentation {
            frozen: target.binding().ok_or(ServiceError::AcpBinding)?,
            checkout: &checkout,
        };
        let Some(_permit) = self.dispatch_gate(&row.task, destination).await? else {
            return Ok(TitleOutcome::Pending);
        };
        self.write_task_title_target(target, task_id, receipt).await
    }

    async fn write_task_title_target(
        &self,
        target: TitleTarget,
        task_id: &str,
        receipt: &TitleReceipt,
    ) -> Result<TitleOutcome, ServiceError> {
        let key = format!("task-{task_id}-title-{}", receipt.generation);
        if self
            .host
            .write_title(target, &key, &receipt.desired)
            .await?
        {
            Ok(TitleOutcome::Confirmed)
        } else {
            Ok(TitleOutcome::Pending)
        }
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
    use crate::tests::registry_fixture;
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
    fn task_labels_use_at_most_four_words() {
        use WaitReason as W;
        let task = task();
        let (_, service) = fixture(GitHub::new("fixture").unwrap());
        let (review, _, _) = crate::tests::reserved_reviewer("review", &service.fixture().start);
        let confirming = WaitDetail::ConfirmingDelivery("Checking GitHub");
        let waits = [
            W::Hold,
            W::Question,
            W::OperatorDeclined,
            W::HostUnknown,
            W::HostObservationBlocked,
            W::Starting,
            W::Running,
            W::IdleWithoutTerminalRun,
            W::Permission,
            W::UsagePermission,
            W::Input,
            W::Stopping,
            W::ForgeUnknown,
            W::ReviewPublicationBlocked,
            W::ExternalMergeBlocked,
            W::WorkspaceUnknown,
            W::WorkspaceBlocked,
            W::ChecksPending,
            W::Prerequisite,
            W::Capacity,
            W::AssignmentTooLarge,
            W::EngineBlocked,
        ];
        for task in [&task, &review] {
            for wait in waits {
                for detail in [None, Some(&confirming)] {
                    let label = task_state_label(task, Some(wait), detail);
                    assert!(
                        label.split_whitespace().filter(|word| *word != "·").count() <= 4,
                        "{label}"
                    );
                }
            }
        }
        // Every hold cause also fits beside the longest phase, "Report ready".
        for by in [None, Some(HoldBy::Operator), Some(HoldBy::Planner)] {
            for reason in ["waiting on an answer", "After (fixture#2)."] {
                assert_eq!(
                    held_label(&Hold {
                        by,
                        reason: reason.into(),
                        actor: None,
                        since_ms: None,
                    })
                    .split_whitespace()
                    .count(),
                    1
                );
            }
        }
    }

    #[tokio::test]
    async fn a_weight_slot_wait_keeps_the_capacity_title() {
        let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
        let task = task();
        let id = task.identity().id.clone();
        let label = "Waiting for a heavy slot (5/5)";
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("stored task");
        state
            .observe_wait_detail(
                &task,
                Some(WaitReason::Capacity),
                Some(WaitDetail::SlotCap(label.into())),
            )
            .expect("slot wait");
        assert_eq!(
            task_state_label(&task, Some(WaitReason::Capacity), state.wait_detail(&id)),
            label
        );
        let (title, _) = service
            .row_label(&state, &task, "thread", TitleTiming::Stable)
            .expect("title label");
        assert_eq!(title, "Queued · capacity");
    }

    #[test]
    fn waiting_labels_describe_the_current_activity() {
        let (_, service) = fixture(GitHub::new("fixture").unwrap());
        let (mut task, _, observation) =
            crate::tests::reservation("waiting", Entry::Brief, &service.fixture().start);
        let label = |task: &Task, wait, detail| task_state_label(task, Some(wait), detail);
        assert_eq!(
            label(&task, WaitReason::Capacity, None),
            "Waiting for a slot"
        );
        assert_eq!(label(&task, WaitReason::Starting, None), "Starting");
        assert_eq!(label(&task, WaitReason::HostUnknown, None), "Starting");
        let paused = WaitDetail::Blocked(
            "Paused: subscription group opencode-go. Resume it in Profiles.".into(),
        );
        assert_eq!(
            label(&task, WaitReason::Capacity, Some(&paused)),
            "Paused · opencode-go"
        );
        let prereqs = WaitDetail::Prerequisites(vec!["fixture#1184".into(), "fixture#1185".into()]);
        assert_eq!(
            label(&task, WaitReason::Prerequisite, Some(&prereqs)),
            "Waiting for #1184 +1"
        );
        let planner = Authority::Planner {
            actor: "planner".into(),
        };
        task.command(
            Command::Hold("After fixture#192".into()),
            &planner,
            &observation,
        )
        .unwrap();
        assert_eq!(label(&task, WaitReason::Hold, None), "Held by planner");
        let operator = Authority::Operator {
            actor: "operator".into(),
        };
        task.command(Command::Hold("Wait".into()), &operator, &observation)
            .unwrap();
        assert_eq!(label(&task, WaitReason::Hold, None), "Held by operator");
        let instance = task.run().unwrap().launch().instance.clone();
        task.record_send(&instance, 1).unwrap();
        assert_eq!(label(&task, WaitReason::Hold, None), "Working*");
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
            "Queued · capacity: #1 Add a greeting"
        );
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(
                    &task,
                    Some(WaitReason::HostUnknown),
                    Some(&WaitDetail::BeforeSend(None))
                )
            ),
            "Queued · T3: #1 Add a greeting"
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
            "Queued · fixture#2: #1 Add a greeting"
        );
        task.command(Command::Hold("Wait for copy".into()), &authority, &obs)
            .expect("hold");
        assert_eq!(
            task_title(
                &task,
                Some(1),
                &task_state_label(&task, Some(WaitReason::Hold), None)
            ),
            "Queued · planner: #1 Add a greeting"
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

    async fn running_review_threads(service: &Service, provider: &str) -> [serde_json::Value; 2] {
        let (task, _, _) = crate::tests::reserved_reviewer("fixture", &service.fixture().start);
        assert_eq!(task.phase(), Phase::Reviewing);
        let parent = "fixture-parent";
        {
            let mut state = service.state.lock().await;
            state
                .store
                .create_with_facts(
                    &task,
                    &crate::event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
            state
                .store
                .desire_title(&task.identity().id, parent, "Reviewing")
                .unwrap();
            state.set_wait(&task.identity().id, Some(WaitReason::ForgeUnknown));
        }
        [
            json!({"id":parent,"projectId":"project:nucleus-rust-inbox","providerInstanceId":provider}),
            json!({"id":task.run().unwrap().launch().thread,"parentThreadId":parent,
                   "projectId":"project:nucleus-rust-inbox","status":"running","activeRunId":"fixture-review"}),
        ]
    }

    fn inbox_shell(
        root: &str,
        provider: &str,
        title: &str,
        children: &[serde_json::Value],
    ) -> serde_json::Value {
        let mut threads = vec![
            json!({"id": INBOX_THREAD, "projectId": "project:nucleus-rust-inbox",
            "providerInstanceId": provider, "worktreePath": null, "title": title, "pinnedAt": "now"}),
        ];
        threads.extend_from_slice(children);
        json!({"projects":[{"id":"project:nucleus-rust-inbox", "workspaceRoot": root}], "threads": threads})
    }

    #[tokio::test]
    async fn a_transient_wait_does_not_replace_an_unpublished_phase() {
        let (_home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
        service.set_fixture_acp_provider(Some("fixture-acp"));
        let mut task = task();
        let id = task.identity().id.clone();
        let thread = nucleus_hosts::parent_thread(&nucleus_work::checkout_path(
            service.storage.work().path(),
            &task.identity().repository,
            &id,
        ));
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.desire_title(&mut state, &task, None);
        let row = state.store.row(&id).unwrap().unwrap();
        let observation = nucleus_core::Observation {
            host: nucleus_core::Observed::Unknown,
            forge: nucleus_core::Observed::Known(nucleus_core::Forge::Absent),
            workspace: nucleus_core::Observed::Known(nucleus_core::Workspace::Absent),
        };
        assert_eq!(
            task.reconcile(&observation),
            nucleus_core::Action::Advance(Phase::Working)
        );
        service
            .commit(&mut state, &row, &task, &event("queue_admitted"), None)
            .unwrap();
        state.set_wait(&id, Some(WaitReason::Capacity));
        service.desire_title(&mut state, &task, row.number);
        assert!(
            state
                .store
                .pending_title(&thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Working:")
        );
        assert!(state.title_candidates.contains_key(&thread));
        state.set_wait(&id, Some(WaitReason::Input));
        service.desire_title(&mut state, &task, row.number);
        assert!(
            state
                .store
                .pending_title(&thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Working · input:")
        );
        assert!(!state.title_candidates.contains_key(&thread));
    }

    async fn apply_stable_inbox_count(
        service: &Service,
        provider: &str,
        root: &str,
        inbox: &[String],
    ) {
        let threads = running_review_threads(service, provider).await;
        for roles in [threads.as_slice(), &[], threads.as_slice()] {
            service
                .host
                .fixture_project_shell(&inbox_shell(root, provider, "All quiet", roles), provider);
            assert!(service.title_work(provider, inbox).await.unwrap().is_none());
            assert_eq!(
                service
                    .state
                    .lock()
                    .await
                    .title_candidates
                    .contains_key(INBOX_THREAD),
                !roles.is_empty()
            );
        }
        service
            .state
            .lock()
            .await
            .title_candidates
            .get_mut(INBOX_THREAD)
            .unwrap()
            .ready = Instant::now();
        let receipt = service.title_work(provider, inbox).await.unwrap().unwrap();
        assert_eq!(receipt.desired, "1 task running");
        service.apply_title(provider, &receipt, 0).await.unwrap();
        let still_pending = service.title_work(provider, inbox).await.unwrap().unwrap();
        assert_eq!(still_pending.generation, receipt.generation);
        assert!(still_pending.retry_at > 0);
        service.host.fixture_project_shell(
            &inbox_shell(root, provider, &receipt.desired, &threads),
            provider,
        );
        assert!(service.title_work(provider, inbox).await.unwrap().is_none());
    }

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "keep the Inbox title generation sequence and shell readback in one fixture"
    )]
    async fn inbox_status_titles_only_write_changed_metadata_under_a_fresh_generation() {
        use nucleus_store::planning::WriteAt;

        let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
        let provider = "fixture-acp";
        service.set_fixture_acp_provider(Some(provider));
        service.native_inbox = Some(crate::native_inbox::NativeInbox::open(&service).unwrap());
        let root = service.native_inbox.as_ref().unwrap().root.clone();
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
        let shell = |title: &str, children: &[serde_json::Value]| {
            inbox_shell(&root, provider, title, children)
        };
        host.fixture_project_shell(&shell("All quiet", &[]), provider);
        service.host = host;
        let inbox = [INBOX_THREAD.to_owned()];
        // Already-matching shell readback confirms generation 1 with zero native calls.
        assert!(
            service
                .title_work(provider, &inbox)
                .await
                .unwrap()
                .is_none()
        );
        assert!(requests.lock().unwrap().is_empty());

        apply_stable_inbox_count(&service, provider, &root, &inbox).await;

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
            .fixture_project_shell(&shell(&decision.desired, &[]), provider);
        assert!(
            service
                .title_work(provider, &inbox)
                .await
                .unwrap()
                .is_none()
        );
        {
            let mut state = service.state.lock().await;
            state.settings.dispatch = None;
            state
                .store
                .answer_decision_with_notice(
                    &project,
                    "test-decision",
                    nucleus_store::planning::DecisionAnswerInput {
                        option_id: "yes".into(),
                        answer: None,
                        based_on_option_id: None,
                        note: None,
                    },
                    stamp("operator", 1),
                    None,
                    None,
                )
                .unwrap();
        }
        let quiet = service.title_work(provider, &inbox).await.unwrap().unwrap();
        assert_eq!(quiet.desired, "All quiet");
        service.apply_title(provider, &quiet, 0).await.unwrap();
        service
            .host
            .fixture_project_shell(&shell("All quiet", &[]), provider);
        assert!(
            service
                .title_work(provider, &inbox)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .map(|payload| payload["commandId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            [2, 3, 4].map(|generation| format!("nucleus-rust-inbox-title-{generation}"))
        );

        // If the held shell later shows an older title for a confirmed Inbox generation,
        // it re-desires under the same command ID rather than advancing the generation.
        service
            .host
            .fixture_project_shell(&shell("1 task running", &[]), provider);
        let redesi = service.title_work(provider, &inbox).await.unwrap().unwrap();
        assert_eq!(redesi.generation, quiet.generation);
        assert_eq!(redesi.desired, "All quiet");
        assert_eq!(redesi.retry_at, 0);
        service.apply_title(provider, &redesi, 0).await.unwrap();
        assert_eq!(
            requests.lock().unwrap().last().unwrap()["commandId"],
            "nucleus-rust-inbox-title-4"
        );
        server.abort();
    }

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "keep the live shell and title receipt round trip in one fixture"
    )]
    async fn native_title_changes_once_and_idle_reconciliation_makes_no_writes() {
        let (_home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
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
        let worktrees = service.worktrees();
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
        let thread_row = |title: &str| {
            json!({"id":parent,"projectId":binding.project_id,"providerInstanceId":"fixture-acp",
                "worktreePath":binding.worktree_path,"branch":binding.branch,"title":title})
        };
        let shell = json!({"kind":"snapshot","snapshot":{"projects":[{"id":binding.project_id,"workspaceRoot":root}],
            "threads":[thread_row("old title")]}});
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
                    "commandId":"task-fixture-title-1","title":"Queued · planner: #1 Add a greeting"})
                );
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            }
            _ => panic!("title work must not read any other host state"),
        })
        .await;
        service.host = host;
        service.set_fixture_acp_provider(Some("fixture-acp"));
        {
            let mut state = service.state.lock().await;
            state
                .store
                .create_with_facts(
                    &subject,
                    &event("admitted"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .expect("seed task");
            let row = service
                .lookup(&state, &subject.identity().id)
                .expect("task");
            service.desire_title(&mut state, &row.task, row.number);
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
            let mut delta_sent = false;
            std::future::poll_fn(|cx| {
                assert!(watcher.as_mut().poll(cx).is_pending());
                // Dispatch alone must not confirm while the shell still displays the old title.
                if !delta_sent
                    && service
                        .host
                        .host_calls()
                        .get("orchestration.dispatchCommand")
                        .copied()
                        == Some(1)
                {
                    let still_pending = service.state.try_lock().is_ok_and(|state| {
                        state
                            .store
                            .pending_title(&parent)
                            .expect("receipt")
                            .is_some()
                    });
                    assert!(still_pending, "title confirmed before shell readback");
                    service.host.fixture_shell_delta(&json!({
                        "kind":"thread.updated",
                        "sequence":2,
                        "thread":thread_row("Queued · planner: #1 Add a greeting")
                    }));
                    delta_sent = true;
                }
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
            let mut state = service.state.lock().await;
            let row = service.lookup(&state, id).unwrap();
            state
                .observe_wait(&row.task, Some(WaitReason::Capacity))
                .unwrap();
            service.desire_title(&mut state, &row.task, row.number);
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

    async fn seeded_title_fixture(
        shell_title: &str,
        handler: impl Fn(&serde_json::Value) -> serde_json::Value + Clone + Send + Sync + 'static,
    ) -> (
        tempfile::TempDir,
        Service,
        tokio::task::JoinHandle<()>,
        String,
        String,
        serde_json::Value,
    ) {
        let (home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
        let task = task();
        let subject = Task::new(
            Identity {
                repository: service.fixture().repository.clone(),
                ..task.identity().clone()
            },
            task.brief().text.clone(),
            None,
        );
        let id = subject.identity().id.clone();
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                &id,
            )
            .expect("checkout");
        checkout
            .allocate(&service.fixture().start)
            .expect("allocate");
        let binding = service.binding(&checkout).expect("workspace binding");
        let parent = nucleus_hosts::parent_thread(checkout.path());
        let root = service.fixture().checkout.clone();
        let row_json = json!({
            "id": parent,
            "projectId": binding.project_id,
            "providerInstanceId": "fixture-acp",
            "worktreePath": binding.worktree_path,
            "branch": binding.branch,
            "title": shell_title,
        });
        let (host, native) = native_fixture(handler).await;
        host.fixture_project_shell(
            &json!({"projects":[{"id":binding.project_id,"workspaceRoot":root}],"threads":[row_json.clone()]}),
            "fixture-acp",
        );
        service.host = host;
        service.set_fixture_acp_provider(Some("fixture-acp"));
        {
            let mut state = service.state.lock().await;
            state
                .store
                .create_with_facts(
                    &subject,
                    &event("admitted"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .expect("seed task");
        }
        (home, service, native, id, parent, row_json)
    }

    #[tokio::test]
    async fn confirmed_title_with_stale_shell_redesires_same_command_id_and_bounds_idle_calls() {
        let dispatches = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&dispatches);
        let (_home, service, native, id, parent, mut row_json) = seeded_title_fixture(
            "Reviewing · snoozed until 2099-01-01: #1 Add a greeting",
            move |req| {
                assert_eq!(req["tag"], "orchestration.dispatchCommand");
                seen.lock().unwrap().push(req["payload"].clone());
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            },
        )
        .await;
        let desired = "Queued: #1 Add a greeting";
        {
            let state = service.state.lock().await;
            state.store.desire_title(&id, &parent, "Old").unwrap();
            let gen1 = state.store.pending_title(&parent).unwrap().unwrap();
            state.store.confirm_title(&gen1).unwrap();
            state.store.desire_title(&id, &parent, desired).unwrap();
            let gen2 = state.store.pending_title(&parent).unwrap().unwrap();
            assert_eq!(gen2.generation, 2);
            // Simulate a pre-fix confirmed receipt whose shell still shows generation 1 wording.
            state.store.confirm_title(&gen2).unwrap();
        }
        let threads = [parent.clone()];
        let receipt = service
            .title_work("fixture-acp", &threads)
            .await
            .unwrap()
            .expect("stale shell must re-desire");
        assert_eq!(receipt.generation, 2);
        assert_eq!(receipt.desired, desired);
        assert_eq!(receipt.retry_at, 0);

        service
            .apply_title("fixture-acp", &receipt, 1_000)
            .await
            .unwrap();
        assert_eq!(
            dispatches.lock().unwrap().as_slice(),
            &[json!({
                "type":"thread.metadata.update",
                "threadId":parent,
                "commandId":"task-fixture-title-2",
                "title":desired,
            })]
        );
        // Before retry_at and before shell readback arrives, idle checks make no writes.
        let deferred = service
            .title_work("fixture-acp", &threads)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deferred.generation, 2);
        assert_eq!(deferred.retry_at, 6_000);
        assert_eq!(dispatches.lock().unwrap().len(), 1);

        // Retry after backoff uses the exact same command ID.
        service
            .apply_title("fixture-acp", &deferred, 6_000)
            .await
            .unwrap();
        assert_eq!(dispatches.lock().unwrap().len(), 2);
        assert_eq!(
            dispatches.lock().unwrap()[1]["commandId"],
            "task-fixture-title-2"
        );
        let backed_off = service
            .title_work("fixture-acp", &threads)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(backed_off.retry_at, 16_000);

        // Shell readback confirms generation 2 without another native call.
        row_json["title"] = json!(desired);
        service.host.fixture_shell_delta(&json!({
            "kind":"thread.updated",
            "sequence":2,
            "thread":row_json,
        }));
        assert!(
            service
                .title_work("fixture-acp", &threads)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            service
                .title_work("fixture-acp", &threads)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(dispatches.lock().unwrap().len(), 2);
        assert!(
            !service
                .host
                .host_calls()
                .contains_key("orchestration.subscribeThread")
        );
        native.abort();
    }

    #[tokio::test]
    async fn already_matching_shell_readback_confirms_without_native_writes() {
        let desired = "Queued: #1 Add a greeting";
        let dispatches = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&dispatches);
        let (_home, service, native, id, parent, _row_json) =
            seeded_title_fixture(desired, move |req| {
                seen.lock().unwrap().push(req.clone());
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            })
            .await;
        {
            let state = service.state.lock().await;
            state.store.desire_title(&id, &parent, desired).unwrap();
            assert!(state.store.pending_title(&parent).unwrap().is_some());
        }
        assert!(
            service
                .title_work("fixture-acp", std::slice::from_ref(&parent))
                .await
                .unwrap()
                .is_none()
        );
        let state = service.state.lock().await;
        assert!(state.store.pending_title(&parent).unwrap().is_none());
        assert!(dispatches.lock().unwrap().is_empty());
        assert!(service.host.host_calls().is_empty());
        native.abort();
    }

    #[tokio::test]
    async fn newer_generation_is_preserved_when_prior_generation_apply_finishes() {
        let dispatches = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&dispatches);
        let (_home, service, native, id, parent, _row_json) =
            seeded_title_fixture("old title", move |req| {
                seen.lock().unwrap().push(req["payload"].clone());
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{}}})
            })
            .await;
        let gen1 = {
            let state = service.state.lock().await;
            state
                .store
                .desire_title(&id, &parent, "Queued: #1 Add a greeting")
                .unwrap();
            state.store.pending_title(&parent).unwrap().unwrap()
        };
        assert_eq!(gen1.generation, 1);

        // Generation 2 supersedes generation 1 before generation 1 finishes confirming/deferring.
        {
            let state = service.state.lock().await;
            state
                .store
                .desire_title(&id, &parent, "Reviewing: #1 Add a greeting")
                .unwrap();
        }
        service
            .finish_title(&gen1, 1_000, Ok(TitleOutcome::Confirmed))
            .await
            .unwrap();
        service
            .finish_title(&gen1, 1_000, Ok(TitleOutcome::Pending))
            .await
            .unwrap();

        let next = service
            .title_work("fixture-acp", std::slice::from_ref(&parent))
            .await
            .unwrap()
            .expect("newer generation must remain pending");
        assert_eq!(next.generation, 2);
        assert_eq!(next.desired, "Reviewing: #1 Add a greeting");
        assert_eq!(next.retry_at, 0);
        service
            .apply_title("fixture-acp", &next, 2_000)
            .await
            .unwrap();
        assert_eq!(
            dispatches.lock().unwrap().as_slice(),
            &[json!({
                "type":"thread.metadata.update",
                "threadId":parent,
                "commandId":"task-fixture-title-2",
                "title":"Reviewing: #1 Add a greeting",
            })]
        );
        native.abort();
    }
}
