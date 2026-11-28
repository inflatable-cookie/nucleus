use super::*;

pub(super) async fn seed_ready_report(service: &Service, id: &str, legacy_attempt: bool) {
    let mut state = service.state.lock().await;
    let (project, repo) = state
        .settings
        .planner_route("alpha-planner")
        .expect("registered route");
    let head: Head = git(&repo.path, &["rev-parse", "HEAD"])
        .parse()
        .expect("planning head");
    let mut task = Task::new_report_only(
        nucleus_core::Identity {
            id: id.into(),
            reference: id.into(),
            repository: repo.origin.clone(),
            base: repo.base.clone(),
            entry: Entry::Brief,
            origin_thread: Some("alpha-planner".into()),
        },
        "Qualify the fixture".into(),
        project.into(),
        "qa".into(),
        head.clone(),
    );
    let mut observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    task.reconcile(&observation);
    let credential = task
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "report-worker".into(),
                started_at: 1,
                input: "fixture".into(),
            },
            &[4; 32],
            None,
            "fixture-group".into(),
        )
        .expect("worker launch");
    let instance = task.run().expect("worker").launch().instance.clone();
    task.record_send(&instance, 2).expect("record worker send");
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::ReportReady(ReportDelivery {
            artifact: ReportArtifact {
                key: "qa".into(),
                version: 3,
                digest: "a".repeat(64),
            },
            headline: None,
            summary: "Synthetic qualification passed".into(),
            head: Some(head),
        }),
    )
    .expect("worker report");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::ReportReady)
    );
    let kind = if legacy_attempt {
        task.mark_report_notice_attempted();
        "report_ready_planner_unavailable"
    } else {
        "report_ready"
    };
    state
        .store
        .create_with_facts(
            &task,
            &event(kind),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .expect("report ready row");
}

pub(super) async fn notice_pass(service: &Service, task: &str) -> Vec<crate::PassOutcome> {
    {
        let mut state = service.state.lock().await;
        let crate::State {
            store,
            schedule,
            capacity_waiters,
            ..
        } = &mut *state;
        let now = tokio::time::Instant::now();
        // Cold fixtures discover persisted notices through the ordinary scheduler scan.
        schedule
            .seed(store, now, capacity_waiters)
            .expect("seed the notice schedule");
        assert!(
            schedule.due(task).is_some_and(|due| due <= now),
            "notice for {task} is not due"
        );
    }
    service.pass().await.expect("scheduler pass")
}

#[derive(Clone, Copy)]
pub(super) enum TaskNotice {
    Report,
    Prerequisite,
    Completion,
}

impl TaskNotice {
    pub(super) async fn fixture(self) -> Registry {
        let registry = registry().await;
        registry.enroll("alpha-planner").await;
        registry.enroll("next-planner").await;
        match self {
            Self::Report => {
                seed_ready_report(&registry.service, "notice", false).await;
            }
            Self::Prerequisite => {
                seed_ready_report(&registry.service, "notice", true).await;
                let mut state = registry.service.state.lock().await;
                let mut identity = state
                    .store
                    .row("notice")
                    .unwrap()
                    .unwrap()
                    .task
                    .identity()
                    .clone();
                "finished".clone_into(&mut identity.id);
                "finished".clone_into(&mut identity.reference);
                let mut completed =
                    serde_json::to_value(Task::new(identity, "Fixture".into(), None)).unwrap();
                completed["phase"] = json!("done");
                state
                    .store
                    .create_with_facts(
                        &serde_json::from_value(completed).unwrap(),
                        &event("fixture"),
                        nucleus_store::TaskAdmissionFacts::default(),
                    )
                    .unwrap();
                drop(state);
                release_notice(&registry).await;
            }
            Self::Completion => {
                let brief = "---\nqueue:\n  complexity: low\n  notifyOriginOnCloseout: true\n---\n# Fix rounding";
                assert_eq!(
                    submit(&registry.api, "alpha-planner", "notice", None)
                        .await
                        .status(),
                    StatusCode::CREATED
                );
                let commands = "/v1/tasks/notice/commands";
                for command in [json!({"amend": brief}), json!("cancel")] {
                    assert_eq!(
                        caller_request(
                            &registry.api,
                            Method::POST,
                            commands,
                            "alpha-planner",
                            command
                        )
                        .await
                        .status(),
                        StatusCode::OK
                    );
                }
            }
        }
        registry.reopen()
    }

    pub(super) async fn pending(self, service: &Service) -> bool {
        match self {
            Self::Report => {
                !service
                    .task("notice")
                    .await
                    .unwrap()
                    .task
                    .report_task()
                    .unwrap()
                    .notice_attempted
            }
            Self::Prerequisite => service
                .state
                .lock()
                .await
                .store
                .pending_prerequisite_notice("notice")
                .unwrap()
                .is_some(),
            Self::Completion => service
                .state
                .lock()
                .await
                .store
                .completion_notice("notice")
                .unwrap()
                .is_some(),
        }
    }
}

pub(super) async fn release_notice(registry: &Registry) {
    let row = registry.service.task("notice").await.unwrap();
    assert_eq!(
        post_json(
            &registry.api,
            "/v1/tasks/notice/commands",
            &BOARD_KEY,
            &json!({"set_prerequisite_wait": {
                "version": row.version, "waits_for": ["finished"], "reason": "Frozen fixture reason"
            }}),
        )
        .await,
        StatusCode::OK
    );
    let parked = registry.service.task("notice").await.unwrap();
    assert!(
        registry
            .service
            .reconcile_prerequisites(&parked)
            .await
            .unwrap()
    );
}

pub(super) async fn assert_idle_notice(registry: &Registry) {
    let service = &registry.service;
    let prior = service.task("notice").await.unwrap();
    let history = service.history("notice", None, 30).await.unwrap();
    let calls = registry.reads.load(Ordering::Relaxed);
    assert_eq!(
        service.notify_report_ready(&prior).await.unwrap(),
        Action::Nothing
    );
    assert!(!service.notify_prerequisite_release(&prior).await.unwrap());
    service.notify_completion(&prior).await.unwrap();
    assert_eq!(registry.reads.load(Ordering::Relaxed), calls);
    assert_eq!(service.task("notice").await.unwrap(), prior);
    assert_eq!(service.history("notice", None, 30).await.unwrap(), history);
}

pub(super) async fn advance_task_notice(registry: &Registry) -> Result<Action, ServiceError> {
    notice_pass(&registry.service, "notice")
        .await
        .into_iter()
        .find(|outcome| outcome.task == "notice")
        .expect("the scheduler processed the notice")
        .result
}
