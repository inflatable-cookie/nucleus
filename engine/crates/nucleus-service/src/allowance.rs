//! Gate new runs on the measured task allowance without interrupting a live turn.

use std::{path::PathBuf, time::Duration};

use longhorn_git_workspace::{Git, GitFailureCode};
use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Action, Phase, Question, Task, WaitReason};
use nucleus_store::{
    AllowanceExtension, AllowanceObservation, AllowanceView, DispatchMode, Store, StoreError,
    TaskRow,
};
use tokio::time::Instant;

use crate::{Service, ServiceError, State, event, web::CachedHost};

const CHECKPOINT_INTERVAL_MS: u64 = 30_000;

pub(super) struct Clock {
    elapsed_ms: u64,
    running_since: Option<Instant>,
    checkpoint_ms: u64,
}

impl Clock {
    pub(super) const fn new(elapsed_ms: u64) -> Self {
        Self {
            elapsed_ms,
            running_since: None,
            checkpoint_ms: elapsed_ms,
        }
    }

    fn elapsed(&self, now: Instant) -> u64 {
        self.elapsed_ms
            .saturating_add(self.running_since.map_or(0, |since| {
                u64::try_from(now.saturating_duration_since(since).as_millis()).unwrap_or(u64::MAX)
            }))
    }

    fn set_running(&mut self, now: Instant, running: bool) {
        match (self.running_since, running) {
            (None, true) => self.running_since = Some(now),
            (Some(_), false) => {
                self.elapsed_ms = self.elapsed(now);
                self.running_since = None;
            }
            _ => {}
        }
    }

    pub(super) fn checkpoint(&mut self, store: &Store, now: Instant) -> Result<(), StoreError> {
        let elapsed = self.elapsed(now);
        if elapsed.saturating_sub(self.checkpoint_ms) >= CHECKPOINT_INTERVAL_MS {
            store.checkpoint_allowance(elapsed)?;
            self.checkpoint_ms = elapsed;
        }
        Ok(())
    }
}

impl State {
    pub(super) fn refresh_allowance_clock(&mut self) {
        let dispatch = self
            .settings
            .dispatch
            .as_ref()
            .map_or(DispatchMode::Running, |value| value.mode);
        self.allowance_clock.set_running(
            Instant::now(),
            self.settings.host == CachedHost::Reachable && dispatch.allows_launch(false),
        );
    }

    pub(super) fn allowance_view(&self, task: &Task) -> Result<AllowanceView, StoreError> {
        Ok(self
            .store
            .allowance(&task.identity().id)?
            .view(task, self.allowance_clock.elapsed(Instant::now())))
    }

    pub(super) fn allowance_transition(
        &self,
        prior: &Task,
        task: &Task,
        audit: &str,
    ) -> AllowanceObservation {
        let changed_work = prior.phase() != task.phase()
            || prior.hold() != task.hold()
            || prior.question() != task.question()
            || matches!(audit, "run_reserved" | "host_send");
        let wait = self.waits.get(&task.identity().id).map(|(wait, _)| *wait);
        self.allowance_observation(
            task,
            if changed_work { None } else { wait },
            (audit == "allowance_extended").then_some(AllowanceExtension::Planner),
        )
    }

    fn allowance_observation(
        &self,
        task: &Task,
        wait: Option<WaitReason>,
        extension: Option<AllowanceExtension>,
    ) -> AllowanceObservation {
        AllowanceObservation {
            elapsed_ms: self.allowance_clock.elapsed(Instant::now()),
            charging: task.has_reserved_run()
                && !matches!(
                    task.phase(),
                    Phase::ReportReady
                        | Phase::Blocked
                        | Phase::Error
                        | Phase::Done
                        | Phase::Cancelled
                )
                && task.hold().is_none()
                && task.question().is_none()
                && task.run().is_none_or(|run| !run.revoked())
                && matches!(wait, None | Some(WaitReason::Running)),
            extension,
        }
    }

    pub(super) fn observe_task_allowance(
        &mut self,
        task: &Task,
        wait: Option<WaitReason>,
    ) -> Result<bool, StoreError> {
        if !task.has_reserved_run() {
            return Ok(false);
        }
        let mut observation = self.allowance_observation(task, wait, None);
        let allowance = self.store.allowance(&task.identity().id)?;
        let audit = (observation.charging
            && wait == Some(WaitReason::Running)
            && allowance.can_extend_automatically()
            && allowance.view(task, observation.elapsed_ms).exhausted)
            .then(automatic_extension);
        if audit.is_some() {
            observation.extension = Some(AllowanceExtension::Automatic);
        }
        if audit.is_some() || allowance.is_charging() != observation.charging {
            self.store
                .observe_allowance(task, observation, audit.as_ref())?;
        }
        Ok(audit.is_some())
    }
}

impl Service {
    /// Read the repository declaration from its chosen commit without running it.
    pub(super) async fn affected_tests(&self, task: &Task, root: PathBuf) -> bool {
        let git = self.git.clone();
        let pinned = task
            .report_task()
            .map(|report| &report.planning_base)
            .or_else(|| self.project.as_ref().map(|project| &project.start));
        let tree = pinned.map_or_else(
            || format!("refs/heads/{}", task.identity().base),
            ToString::to_string,
        );
        tokio::task::spawn_blocking(move || {
            let git = Git::new(&git, Redactor::new([], RedactionRules::common()));
            git.run(
                &root,
                &["show", &format!("{tree}:effigy.toml")],
                GitFailureCode::CommandUnavailable,
                Duration::from_secs(5),
            )
            .ok()
            .is_some_and(|document| declares_affected_tests(&document))
        })
        .await
        .unwrap_or(false)
    }

    /// Apply the same allowance gate before reservation and before an unsent reservation is sent.
    /// The caller holds the exact task effect fence.
    pub(super) async fn gate_allowance(
        &self,
        row: &TaskRow,
    ) -> Result<Option<Action>, ServiceError> {
        let task = &row.task;
        if !task.has_reserved_run()
            || task
                .run()
                .is_some_and(|run| run.last_send_at_ms().is_some())
        {
            return Ok(None);
        }
        let mut state = self.state.lock().await;
        let mut observation = state.allowance_observation(task, None, None);
        let allowance = state.store.allowance(&task.identity().id)?;
        let view = allowance.view(task, observation.elapsed_ms);
        if !view.exhausted {
            return Ok(None);
        }
        if allowance.can_extend_automatically() {
            observation.extension = Some(AllowanceExtension::Automatic);
            state
                .store
                .observe_allowance(task, observation, Some(&automatic_extension()))?;
            self.publish(&task.identity().id, row.version);
            return Ok(None);
        }
        let mut question = task.clone();
        if question.ask_allowance(view.used_ms, view.limit_ms) {
            self.commit(&mut state, row, &question, &event("question_asked"), None)?;
        }
        Ok(Some(Action::Wait(WaitReason::Question)))
    }

    pub(super) async fn clear_surpassed_allowance_question(
        &self,
        row: &TaskRow,
    ) -> Result<bool, ServiceError> {
        if !matches!(row.task.question(), Some(Question::Allowance { .. })) {
            return Ok(false);
        }
        let _fence = self.effect(row).await?;
        let mut state = self.state.lock().await;
        if state.allowance_view(&row.task)?.exhausted {
            return Ok(false);
        }
        let mut task = row.task.clone();
        task.clear_allowance_question();
        self.commit(
            &mut state,
            row,
            &task,
            &event("allowance_wait_cleared"),
            None,
        )?;
        Ok(true)
    }
}

fn automatic_extension() -> nucleus_store::EventDraft {
    let mut audit = event("allowance_extended");
    audit.detail = "automatic first increment".into();
    audit
}

fn declares_affected_tests(document: &str) -> bool {
    toml::from_str::<toml::Table>(document)
        .ok()
        .and_then(|config| {
            config
                .get("tasks")
                .and_then(toml::Value::as_table)
                .map(|tasks| tasks.contains_key("test:affected"))
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use nucleus_core::{Answer, Authority, Command, Entry};
    use nucleus_forge::GitHub;

    use super::*;
    use crate::tests::{fixture, git, reservation};

    #[test]
    fn pause_and_restart_exclude_unobserved_time() {
        let start = Instant::now();
        let mut clock = Clock::new(0);
        clock.set_running(start, true);
        clock.set_running(start + Duration::from_secs(8), false);
        assert_eq!(clock.elapsed(start + Duration::from_secs(1_000)), 8_000);
        let mut restarted = Clock::new(clock.elapsed(start + Duration::from_secs(1_000)));
        let resume = start + Duration::from_secs(1_100);
        restarted.set_running(resume, true);
        assert_eq!(restarted.elapsed(resume + Duration::from_secs(2)), 10_000);
    }

    #[tokio::test]
    async fn admission_pins_the_affected_test_declaration() {
        let (_root, mut service) = fixture(GitHub::new("unused").unwrap());
        let checkout = service.fixture().checkout.clone();
        let config = checkout.join("effigy.toml");
        std::fs::write(&config, "[tasks]\n\"test:affected\" = \"test\"\n").unwrap();
        git(&checkout, &["add", "effigy.toml"]);
        git(
            &checkout,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "Declare affected selection",
            ],
        );
        service.fixture_mut().start = git(&checkout, &["rev-parse", "HEAD"])
            .trim()
            .parse()
            .unwrap();
        std::fs::write(&config, "# Dirty checkout has no test declaration\n").unwrap();
        let row = service
            .admit(
                "affected".into(),
                "affected".into(),
                "---\nqueue:\n  complexity: very_low\n---\nFixture brief.".into(),
                &Authority::Operator {
                    actor: "fixture".into(),
                },
            )
            .await
            .unwrap();
        let state = service.state.lock().await;
        let view = state.allowance_view(&row.task).unwrap();
        assert_eq!(view.used_ms, 0);
        assert_eq!(view.limit_ms, 120 * 60_000);
    }

    #[tokio::test]
    async fn a_legacy_run_starts_at_first_observation_then_extends_once_automatically() {
        let (_root, service) = fixture(GitHub::new("unused").unwrap());
        let (task, _, observation) = reservation("legacy", Entry::Brief, &service.fixture().start);
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        state.allowance_clock = Clock::new(3_600_000);
        assert_eq!(state.allowance_view(&task).unwrap().used_ms, 0);
        state
            .observe_task_allowance(&task, Some(WaitReason::Running))
            .unwrap();
        state.allowance_clock = Clock::new(3_620_000);
        state
            .observe_task_allowance(&task, Some(WaitReason::Hold))
            .unwrap();
        state.allowance_clock = Clock::new(3_680_000);
        assert_eq!(state.allowance_view(&task).unwrap().used_ms, 20_000);
        state
            .observe_task_allowance(&task, Some(WaitReason::Running))
            .unwrap();

        let limit = 180 * 60_000;
        let first_spend = 3_600_000 + 60_000 + limit;
        state.allowance_clock = Clock::new(first_spend);
        let row = service.lookup(&state, "legacy").unwrap();
        drop(state);

        let _fence = service.effect(&row).await.unwrap();
        assert_eq!(service.gate_allowance(&row).await.unwrap(), None);
        let mut state = service.state.lock().await;
        assert_eq!(state.allowance_view(&task).unwrap().limit_ms, 2 * limit);
        let second_spend = first_spend + limit + 1_000;
        state.allowance_clock = Clock::new(second_spend);
        drop(state);
        assert_eq!(
            service.gate_allowance(&row).await.unwrap(),
            Some(Action::Wait(WaitReason::Question))
        );
        let mut state = service.state.lock().await;
        let asked = service.lookup(&state, "legacy").unwrap();
        assert!(matches!(
            asked.task.question(),
            Some(Question::Allowance { .. })
        ));
        let mut updated = asked.task.clone();
        let planner = Authority::Planner {
            actor: "fixture planner".into(),
        };
        updated
            .command(Command::Answer(Answer::Extend), &planner, &observation)
            .unwrap();
        service
            .commit(
                &mut state,
                &asked,
                &updated,
                &event("allowance_extended"),
                None,
            )
            .unwrap();
        let view = state.allowance_view(&updated).unwrap();
        assert_eq!(view.used_ms, 2 * limit + 1_000);
        assert_eq!(view.limit_ms, 3 * limit + 1_000);
        assert_eq!(updated.question(), None);
        assert!(
            updated.run().is_some(),
            "the unsent reservation still belongs to the task"
        );
        drop(state);
        let store = Store::open(&service.storage).unwrap();
        let restarted = Clock::new(store.allowance_elapsed().unwrap());
        assert_eq!(
            store
                .allowance("legacy")
                .unwrap()
                .view(&updated, restarted.elapsed(Instant::now())),
            view
        );
    }
}
