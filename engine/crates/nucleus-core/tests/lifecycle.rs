use nucleus_core::{
    Action, Answer, Authority, CallbackCredential, CheckState, CloseWorkspace, Command,
    CommandError, Entry, Forge, Head, Host, Identity, Launch, LaunchInputs, Observation, Observed,
    Phase, PullRequest, Question, Repair, Report, RetainedThread, Review, Role, RunState, Task,
    Verdict, WaitReason, Workspace, decide,
};

const SEED: [u8; 32] = [7; 32];

fn sha(digit: char) -> Head {
    digit.to_string().repeat(40).parse().expect("test SHA")
}

fn pr(digit: char) -> PullRequest {
    PullRequest {
        url: "https://github.com/example/fixture/pull/1".into(),
        head: sha(digit),
    }
}

fn task(entry: Entry) -> Task {
    Task::new(
        Identity {
            id: "task-1".into(),
            reference: "fixture#1".into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry,
            origin_thread: None,
        },
        "Add the greeting".into(),
        (entry == Entry::ReviewEntry).then(|| pr('a')),
    )
}

fn observation() -> Observation {
    Observation {
        host: Observed::Unknown,
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    }
}

fn open(digit: char, checks: CheckState) -> Observation {
    Observation {
        forge: Observed::Known(Forge::Open {
            pr: pr(digit),
            checks,
        }),
        workspace: Observed::Known(Workspace::Clean(sha(digit))),
        ..observation()
    }
}

fn merged(digit: char, workspace: Workspace) -> Observation {
    Observation {
        forge: Observed::Known(Forge::Merged {
            pr: pr(digit),
            commit: sha('f'),
        }),
        workspace: Observed::Known(workspace),
        ..observation()
    }
}

fn host(task: &Task, observation: Observation, state: RunState) -> Observation {
    Observation {
        host: Observed::Known(Host::Current {
            instance: task.run().expect("bound run").launch().instance.clone(),
            state,
        }),
        ..observation
    }
}

fn retained(observation: Observation, thread: &str, state: RetainedThread) -> Observation {
    Observation {
        host: Observed::Known(Host::Retained {
            thread: thread.into(),
            state,
        }),
        ..observation
    }
}

fn start(
    task: &mut Task,
    obs: &Observation,
    role: Role,
    thread: &str,
    input: &str,
) -> CallbackCredential {
    let bearer = task
        .reserve_launch(
            obs,
            LaunchInputs {
                scratch: None,
                thread: thread.into(),
                started_at: 1,
                input: input.into(),
            },
            &SEED,
        )
        .expect("reserve launch");
    assert_eq!(task.run().expect("bound run").launch().role, role);
    bearer
}

fn instance(task: &Task) -> String {
    task.run().expect("bound run").launch().instance.clone()
}

fn report(task: &mut Task, bearer: &CallbackCredential, value: Report) {
    task.record_report(&instance(task), bearer.as_bytes(), value)
        .expect("record report");
}

fn planner() -> Authority {
    Authority::Planner {
        actor: "fixture-planner".into(),
    }
}

fn working() -> (Task, Observation) {
    let mut task = task(Entry::Brief);
    assert_eq!(
        task.reconcile(&observation()),
        Action::Advance(Phase::Working)
    );
    let obs = Observation {
        workspace: Observed::Known(Workspace::Absent),
        ..observation()
    };
    (task, obs)
}

fn ready_for_merge() -> Task {
    let (mut task, obs) = working();
    assert_eq!(
        decide(&task, &obs),
        Action::Launch {
            role: Role::Worker,
            via: Launch::Create
        }
    );
    let bearer = start(&mut task, &obs, Role::Worker, "worker", "work-1");
    report(&mut task, &bearer, Report::Work(pr('a').into()));
    let review = open('a', CheckState::Pending);
    let ended = host(&task, review.clone(), RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
    let bearer = start(&mut task, &review, Role::Reviewer, "reviewer", "review-1");
    report(
        &mut task,
        &bearer,
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Matches brief".into(),
            finding_titles: Vec::new(),
        },
    );
    let ended = host(&task, review, RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Merging));
    task
}

#[test]
fn approved_head_merges_and_only_a_published_clean_checkout_is_removed() {
    let mut task = ready_for_merge();
    assert_eq!(
        decide(&task, &observation()),
        Action::Wait(WaitReason::ForgeUnknown)
    );
    assert_eq!(
        decide(&task, &open('a', CheckState::Unknown)),
        Action::Wait(WaitReason::ForgeUnknown)
    );
    assert_eq!(
        decide(&task, &open('a', CheckState::Pending)),
        Action::Wait(WaitReason::ChecksPending)
    );
    assert_eq!(
        decide(&task, &open('a', CheckState::Blocked)),
        Action::Ask(Question::Repair(Repair::MergeBlocked))
    );
    assert_eq!(
        decide(&task, &open('a', CheckState::Ready)),
        Action::Merge { head: sha('a') }
    );
    let blocked = open('a', CheckState::Blocked);
    assert_eq!(
        task.reconcile(&blocked),
        Action::Ask(Question::Repair(Repair::MergeBlocked))
    );
    for unchanged in [blocked, open('a', CheckState::Unknown), observation()] {
        assert_eq!(
            task.reconcile(&unchanged),
            Action::Wait(WaitReason::Question)
        );
    }
    let pending = open('a', CheckState::Pending);
    assert_eq!(task.reconcile(&pending), Action::Advance(Phase::Merging));
    assert_eq!(task.question(), None);
    assert_eq!(
        decide(&task, &pending),
        Action::Wait(WaitReason::ChecksPending)
    );

    let clean = merged('a', Workspace::Clean(sha('a')));
    assert_eq!(task.reconcile(&clean), Action::Advance(Phase::Closing));
    assert_eq!(
        decide(&task, &clean),
        Action::Close {
            commit: sha('f'),
            workspace: CloseWorkspace::RemoveClean { head: sha('a') },
        }
    );
    assert!(!task.finish_close(&clean));
    assert_eq!(
        decide(
            &task,
            &Observation {
                workspace: Observed::Unknown,
                ..clean
            }
        ),
        Action::Wait(WaitReason::WorkspaceUnknown)
    );
    assert_eq!(
        task.reconcile(&open('a', CheckState::Ready)),
        Action::Ask(Question::Repair(Repair::MergeUnconfirmed))
    );
    assert_eq!(
        task.reconcile(&observation()),
        Action::Wait(WaitReason::Question)
    );
    assert_eq!(
        task.reconcile(&merged('a', Workspace::Clean(sha('a')))),
        Action::Advance(Phase::Closing)
    );
    assert_eq!(task.question(), None);
    for workspace in [Workspace::Dirty, Workspace::Clean(sha('b'))] {
        let retained = merged('a', workspace);
        assert_eq!(
            decide(&task, &retained),
            Action::Close {
                commit: sha('f'),
                workspace: CloseWorkspace::Retain
            }
        );
        assert!(task.clone().finish_close(&retained));
    }
    assert!(task.finish_close(&merged('a', Workspace::Absent)));
    assert_eq!(task.phase(), Phase::Done);
    assert_eq!(decide(&task, &observation()), Action::Nothing);
}

#[test]
fn a_replaced_head_never_inherits_approval_and_keeps_the_reviewer() {
    let mut task = ready_for_merge();
    let new_head = open('b', CheckState::Ready);
    assert_eq!(
        task.command(Command::Move(Phase::Merging), &planner(), &new_head),
        Err(CommandError::HeadChanged)
    );
    assert_eq!(task.reconcile(&new_head), Action::Advance(Phase::Reviewing));
    assert_eq!(task.pull_request(), Some(&pr('b')));
    assert_eq!(task.threads().get(Role::Reviewer), Some("reviewer"));
    assert_eq!(
        decide(&task, &new_head),
        Action::Wait(WaitReason::HostUnknown)
    );
    assert_eq!(
        decide(
            &task,
            &retained(new_head.clone(), "other", RetainedThread::Idle)
        ),
        Action::Wait(WaitReason::HostUnknown)
    );
    assert_eq!(
        decide(
            &task,
            &retained(new_head.clone(), "reviewer", RetainedThread::Busy)
        ),
        Action::Wait(WaitReason::RetainedThreadBusy)
    );
    assert_eq!(
        decide(
            &task,
            &retained(new_head.clone(), "reviewer", RetainedThread::Idle)
        ),
        Action::Launch {
            role: Role::Reviewer,
            via: Launch::Continue {
                thread: "reviewer".into()
            }
        }
    );
    let gone = retained(new_head, "reviewer", RetainedThread::Gone);
    assert_eq!(
        decide(&task, &gone),
        Action::Launch {
            role: Role::Reviewer,
            via: Launch::Create
        }
    );
    start(&mut task, &gone, Role::Reviewer, "replacement", "review-2");
    assert_eq!(task.threads().get(Role::Reviewer), Some("reviewer"));
    task.record_send(&instance(&task), 1)
        .expect("possible send");
    assert_eq!(task.threads().get(Role::Reviewer), Some("replacement"));
}

#[test]
fn discarding_an_unsent_review_keeps_only_an_established_thread() {
    let mut task = task(Entry::ReviewEntry);
    let open = open('a', CheckState::Ready);
    let missing = Observation {
        workspace: Observed::Known(Workspace::Absent),
        ..open.clone()
    };
    start(
        &mut task,
        &open,
        Role::Reviewer,
        "provisional",
        "unsent create",
    );
    assert_eq!(task.reconcile(&missing), Action::Advance(Phase::Reviewing));
    assert!(task.run().is_none());
    assert_eq!(task.threads().get(Role::Reviewer), None);
    assert_eq!(
        decide(&task, &missing),
        Action::Wait(WaitReason::WorkspaceUnknown)
    );

    start(
        &mut task,
        &open,
        Role::Reviewer,
        "established",
        "first send",
    );
    task.record_send(&instance(&task), 1)
        .expect("possible send");
    task.command(Command::Move(Phase::Reviewing), &planner(), &open)
        .expect("revoke");
    let ended = host(&task, open.clone(), RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
    let idle = retained(open, "established", RetainedThread::Idle);
    start(
        &mut task,
        &idle,
        Role::Reviewer,
        "established",
        "unsent continuation",
    );
    assert_eq!(task.reconcile(&missing), Action::Advance(Phase::Reviewing));
    assert!(task.run().is_none());
    assert_eq!(task.threads().get(Role::Reviewer), Some("established"));
}

#[test]
fn a_stale_review_report_refreshes_the_head_without_applying_a_verdict() {
    let mut task = task(Entry::ReviewEntry);
    let bearer = start(
        &mut task,
        &open('a', CheckState::Ready),
        Role::Reviewer,
        "reviewer",
        "review-1",
    );
    report(
        &mut task,
        &bearer,
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Reviewed".into(),
            finding_titles: Vec::new(),
        },
    );
    let changed = host(&task, open('b', CheckState::Ready), RunState::Running);
    assert_eq!(task.reconcile(&changed), Action::Advance(Phase::Reviewing));
    assert_eq!(task.pull_request(), Some(&pr('b')));
    assert_eq!(task.verdict(), None);
}

#[test]
fn changes_continue_the_worker_and_require_a_new_head() {
    let (mut task, obs) = working();
    let bearer = start(&mut task, &obs, Role::Worker, "worker", "work-1");
    report(&mut task, &bearer, Report::Work(pr('a').into()));
    let review = open('a', CheckState::Ready);
    assert_eq!(task.reconcile(&review), Action::Advance(Phase::Reviewing));
    let bearer = start(&mut task, &review, Role::Reviewer, "reviewer", "review-1");
    report(
        &mut task,
        &bearer,
        Report::Review {
            head: sha('a'),
            decision: Review::Changes,
            summary: "Add handling for empty input".into(),
            finding_titles: Vec::new(),
        },
    );
    assert_eq!(task.reconcile(&review), Action::Advance(Phase::Working));
    let worker = retained(review.clone(), "worker", RetainedThread::Idle);
    assert_eq!(
        decide(&task, &worker),
        Action::Launch {
            role: Role::Worker,
            via: Launch::Continue {
                thread: "worker".into()
            }
        }
    );
    let bearer = start(&mut task, &worker, Role::Worker, "worker", "work-2");
    report(&mut task, &bearer, Report::Work(pr('a').into()));
    let ended = host(&task, review, RunState::Ended);
    assert_eq!(
        task.reconcile(&ended),
        Action::Ask(Question::Repair(Repair::RevisionHasSameHead))
    );
    assert_eq!(
        task.reconcile(&open('a', CheckState::Ready)),
        Action::Wait(WaitReason::Question)
    );
    assert_eq!(
        task.reconcile(&observation()),
        Action::Wait(WaitReason::Question)
    );
    assert_eq!(
        task.reconcile(&open('b', CheckState::Ready)),
        Action::Advance(Phase::Working)
    );
    assert_eq!(task.question(), None);
}

#[test]
fn uncertain_or_blocked_host_observations_do_not_spend_attempts() {
    let (mut task, obs) = working();
    assert_eq!(
        decide(&task, &observation()),
        Action::Wait(WaitReason::WorkspaceUnknown)
    );
    start(&mut task, &obs, Role::Worker, "worker", "work-1");
    assert_eq!(task.reconcile(&obs), Action::Wait(WaitReason::HostUnknown));
    let retry = host(&task, obs.clone(), RunState::ReadyToSend);
    assert_eq!(
        task.reconcile(&retry),
        Action::Launch {
            role: Role::Worker,
            via: Launch::SendPrepared
        }
    );
    assert_eq!(
        task.run().expect("reserved").launch().instance,
        "task-task-1-run-1"
    );
    for (state, reason) in [
        (RunState::Starting, WaitReason::Starting),
        (RunState::Running, WaitReason::Running),
        (
            RunState::IdleWithoutTerminalRun,
            WaitReason::IdleWithoutTerminalRun,
        ),
        (RunState::Permission, WaitReason::Permission),
        (RunState::Input, WaitReason::Input),
    ] {
        assert_eq!(
            task.reconcile(&host(&task, obs.clone(), state)),
            Action::Wait(reason)
        );
    }
    assert_eq!(task.attempts(), 0);
}

#[test]
fn three_confirmed_failures_open_one_question_and_retry_reuses_the_thread() {
    let (mut task, obs) = working();
    start(&mut task, &obs, Role::Worker, "worker", "work-1");
    let rejected = host(&task, obs.clone(), RunState::Rejected);
    assert_eq!(task.reconcile(&rejected), Action::Relaunch(Role::Worker));
    assert_eq!(task.attempts(), 1);
    let idle = retained(obs.clone(), "worker", RetainedThread::Idle);
    start(&mut task, &idle, Role::Worker, "worker", "work-2");
    let silent = host(&task, obs.clone(), RunState::Ended);
    assert_eq!(task.reconcile(&silent), Action::Relaunch(Role::Worker));
    assert_eq!(task.attempts(), 2);
    start(&mut task, &idle, Role::Worker, "worker", "work-3");
    let gone = host(&task, obs, RunState::Gone);
    assert_eq!(
        task.reconcile(&gone),
        Action::Ask(Question::Retry { role: Role::Worker })
    );
    assert_eq!(task.attempts(), 3);
    assert_eq!(task.reconcile(&idle), Action::Wait(WaitReason::Question));
    task.command(Command::Answer(Answer::Retry), &planner(), &idle)
        .expect("retry");
    assert_eq!(task.attempts(), 0);
    assert_eq!(
        decide(&task, &idle),
        Action::Launch {
            role: Role::Worker,
            via: Launch::Continue {
                thread: "worker".into()
            }
        }
    );
}

#[test]
fn the_first_pr_seen_as_a_worker_ends_does_not_inherit_its_failures() {
    let (mut task, workspace) = working();
    let no_pr = Observation {
        forge: Observed::Known(Forge::Absent),
        ..workspace
    };
    let idle = retained(no_pr.clone(), "worker", RetainedThread::Idle);
    start(&mut task, &no_pr, Role::Worker, "worker", "initial work");
    for _ in 0..2 {
        let ended = host(&task, no_pr.clone(), RunState::Ended);
        assert_eq!(task.reconcile(&ended), Action::Relaunch(Role::Worker));
        start(&mut task, &idle, Role::Worker, "worker", "retry");
    }
    assert_eq!(task.attempts(), 2);

    let first_pr = host(&task, open('a', CheckState::Ready), RunState::Ended);
    assert_eq!(task.reconcile(&first_pr), Action::Advance(Phase::Working));
    assert_eq!(task.attempts(), 0);
    assert_eq!(task.pull_request(), Some(&pr('a')));
    assert_eq!(task.question(), None);
}

#[test]
fn the_first_pr_seen_between_worker_runs_resets_the_next_launch() {
    let (mut task, no_pr) = working();
    start(&mut task, &no_pr, Role::Worker, "worker", "initial work");
    let ended = host(&task, no_pr, RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Relaunch(Role::Worker));
    assert_eq!(task.attempts(), 1);

    let first_pr = retained(open('a', CheckState::Ready), "worker", RetainedThread::Idle);
    assert_eq!(task.reconcile(&first_pr), Action::Advance(Phase::Working));
    assert_eq!(task.attempts(), 0);
    assert_eq!(task.pull_request(), Some(&pr('a')));
    start(
        &mut task,
        &first_pr,
        Role::Worker,
        "worker",
        "first PR work",
    );
    assert_eq!(
        task.run().expect("bound run").launch().label,
        format!("task-task-1-working-{}-0", sha('a'))
    );
}

#[test]
fn revocation_is_reconciled_without_a_person_even_after_cancellation() {
    for (command, phase) in [
        (Command::Cancel, Phase::Cancelled),
        (Command::Move(Phase::Working), Phase::Working),
    ] {
        let (mut task, obs) = working();
        start(&mut task, &obs, Role::Worker, "worker", "work-1");
        let failed = host(&task, obs.clone(), RunState::Ended);
        task.reconcile(&failed);
        let idle = retained(obs.clone(), "worker", RetainedThread::Idle);
        let bearer = start(&mut task, &idle, Role::Worker, "worker", "work-2");
        let old_instance = instance(&task);
        task.command(command, &planner(), &obs).expect("revoke");
        assert_eq!(task.phase(), phase);
        assert_eq!(task.attempts(), 0);
        assert!(task.run().expect("still bound").revoked());
        assert_eq!(
            task.record_report(
                &old_instance,
                bearer.as_bytes(),
                Report::Work(pr('a').into())
            ),
            Err(CommandError::InvalidReportCredential)
        );
        assert_eq!(task.reconcile(&obs), Action::Wait(WaitReason::Stopping));
        let running = host(&task, obs.clone(), RunState::Running);
        assert_eq!(task.reconcile(&running), Action::Wait(WaitReason::Stopping));
        assert_eq!(task.question(), None);
        let ended = host(&task, obs, RunState::Ended);
        assert_eq!(task.reconcile(&ended), Action::Advance(phase));
        assert!(task.run().is_none());
        assert_eq!(task.threads().get(Role::Worker), Some("worker"));
        if phase == Phase::Cancelled {
            assert_eq!(decide(&task, &ended), Action::Nothing);
        } else {
            start(&mut task, &idle, Role::Worker, "worker", "work-3");
            assert_eq!(
                task.run().expect("fresh run").launch().instance,
                "task-task-1-run-3"
            );
        }
    }
}

#[test]
fn external_merge_acceptance_is_exact_and_entry_controls_authority() {
    let same_head = merged('a', Workspace::Dirty);
    let changed_head = merged('b', Workspace::Dirty);
    for entry in [Entry::Brief, Entry::ReviewEntry] {
        let mut task = task(entry);
        if entry == Entry::Brief {
            task.reconcile(&observation());
        }
        assert_eq!(
            task.reconcile(&same_head),
            Action::Ask(Question::Accept { head: sha('a') })
        );
        assert_eq!(
            task.command(Command::Move(Phase::Done), &planner(), &same_head),
            Err(CommandError::MergeAuthorityRequired)
        );
        let answer = Command::Answer(Answer::Accept {
            head: sha('a'),
            reason: "Checked fixture".into(),
        });
        assert_eq!(
            task.command(answer.clone(), &planner(), &changed_head),
            Err(CommandError::AnswerDoesNotMatch)
        );
        let mut refreshed = task.clone();
        assert_eq!(
            refreshed.reconcile(&changed_head),
            Action::Advance(task.phase())
        );
        assert_eq!(refreshed.question(), None);
        assert_eq!(
            refreshed.reconcile(&changed_head),
            Action::Ask(Question::Accept { head: sha('b') })
        );
        if entry == Entry::ReviewEntry {
            assert_eq!(
                task.command(answer.clone(), &planner(), &same_head),
                Err(CommandError::OperatorRequired)
            );
            task.command(
                answer,
                &Authority::Operator {
                    actor: "fixture-operator".into(),
                },
                &same_head,
            )
            .expect("operator acceptance");
        } else {
            task.command(answer, &planner(), &same_head)
                .expect("planner acceptance");
        }
        assert!(
            matches!(task.verdict(), Some(Verdict::Accepted { head, .. }) if *head == sha('a'))
        );
        assert_eq!(task.reconcile(&same_head), Action::Advance(Phase::Closing));
        assert!(task.finish_close(&same_head));
    }
}

#[test]
fn an_authenticated_question_updates_the_brief_and_a_hold_survives_amendment() {
    let (mut task, obs) = working();
    task.command(Command::Hold("wait for copy".into()), &planner(), &obs)
        .expect("hold");
    task.command(
        Command::Amend("Add the English greeting".into()),
        &planner(),
        &obs,
    )
    .expect("amend");
    assert_eq!(decide(&task, &obs), Action::Wait(WaitReason::Hold));
    task.command(Command::Release, &planner(), &obs)
        .expect("release");
    let bearer = start(&mut task, &obs, Role::Worker, "worker", "work-1");
    let question = Report::Question {
        prompt: "Which spelling?".into(),
        options: vec!["UK".into(), "US".into()],
    };
    let prior_digest = task.brief().digest;
    report(&mut task, &bearer, question.clone());
    report(&mut task, &bearer, question);
    assert_eq!(
        task.record_report(
            &instance(&task),
            bearer.as_bytes(),
            Report::Work(pr('a').into())
        ),
        Err(CommandError::ReportAlreadyReceived)
    );
    let ended = host(&task, obs, RunState::Ended);
    assert!(matches!(
        task.reconcile(&ended),
        Action::Ask(Question::Work { .. })
    ));
    task.command(
        Command::Answer(Answer::Work("UK".into())),
        &planner(),
        &ended,
    )
    .expect("answer");
    assert!(task.brief().text.ends_with("UK"));
    assert_eq!(task.brief().version, 3);
    assert_ne!(task.brief().digest, prior_digest);
    assert_eq!(task.question(), None);
}

#[test]
fn a_repaired_checkout_resolves_its_question_at_the_same_head() {
    let mut task = task(Entry::ReviewEntry);
    let ready = open('a', CheckState::Ready);
    let dirty = Observation {
        workspace: Observed::Known(Workspace::Dirty),
        ..ready.clone()
    };
    assert_eq!(
        task.reconcile(&dirty),
        Action::Ask(Question::Repair(Repair::WorkspaceHeadMismatch))
    );
    for unknown in [
        Observation {
            forge: Observed::Unknown,
            ..ready.clone()
        },
        Observation {
            workspace: Observed::Unknown,
            ..ready.clone()
        },
        Observation {
            workspace: Observed::Known(Workspace::Clean(sha('b'))),
            ..ready.clone()
        },
    ] {
        assert_eq!(task.reconcile(&unknown), Action::Wait(WaitReason::Question));
    }
    assert_eq!(task.reconcile(&ready), Action::Advance(Phase::Reviewing));
    assert_eq!(task.question(), None);
    assert_eq!(
        decide(&task, &ready),
        Action::Launch {
            role: Role::Reviewer,
            via: Launch::Create
        }
    );
}

#[test]
fn review_handoff_checks_workspace_and_credential_binding() {
    let mut task = task(Entry::ReviewEntry);
    let open = open('a', CheckState::Ready);
    for (workspace, action) in [
        (
            Observed::Unknown,
            Action::Wait(WaitReason::WorkspaceUnknown),
        ),
        (
            Observed::Known(Workspace::Dirty),
            Action::Ask(Question::Repair(Repair::WorkspaceHeadMismatch)),
        ),
        (
            Observed::Known(Workspace::Clean(sha('b'))),
            Action::Ask(Question::Repair(Repair::WorkspaceHeadMismatch)),
        ),
        (
            Observed::Known(Workspace::Absent),
            Action::Wait(WaitReason::WorkspaceUnknown),
        ),
    ] {
        assert_eq!(
            decide(
                &task,
                &Observation {
                    workspace,
                    ..open.clone()
                }
            ),
            action
        );
    }
    let closed = Observation {
        forge: Observed::Known(Forge::Closed(pr('a'))),
        ..open.clone()
    };
    assert_eq!(
        task.reconcile(&closed),
        Action::Ask(Question::Repair(Repair::PullRequestUnavailable))
    );
    assert_eq!(task.reconcile(&closed), Action::Wait(WaitReason::Question));
    assert_eq!(
        task.reconcile(&observation()),
        Action::Wait(WaitReason::Question)
    );
    assert_eq!(task.reconcile(&open), Action::Advance(Phase::Reviewing));
    assert_eq!(task.question(), None);
    let bearer = start(&mut task, &open, Role::Reviewer, "reviewer", "review-1");
    let report = Report::Review {
        head: sha('b'),
        decision: Review::Approve,
        summary: "Wrong head".into(),
        finding_titles: Vec::new(),
    };
    assert_eq!(
        task.record_report(&instance(&task), &[0; 32], report.clone()),
        Err(CommandError::InvalidReportCredential)
    );
    assert_eq!(
        task.record_report(&instance(&task), bearer.as_bytes(), report),
        Err(CommandError::ReportDoesNotMatch)
    );
    let prepare = host(&task, open.clone(), RunState::ReadyToSend);
    assert_eq!(
        decide(&task, &prepare),
        Action::Launch {
            role: Role::Reviewer,
            via: Launch::SendPrepared
        }
    );
    let unavailable = Observation {
        forge: Observed::Unknown,
        ..prepare
    };
    assert_eq!(
        decide(&task, &unavailable),
        Action::Wait(WaitReason::ForgeUnknown)
    );
}

#[test]
fn restoring_a_review_entry_rejects_planner_acceptance() {
    let (mut task, _) = working();
    let forge = merged('a', Workspace::Dirty);
    task.reconcile(&forge);
    task.command(
        Command::Answer(Answer::Accept {
            head: sha('a'),
            reason: "checked the work".into(),
        }),
        &planner(),
        &forge,
    )
    .expect("brief entry permits planner acceptance");
    let mut saved = serde_json::to_value(&task).expect("encode routine state");
    assert_eq!(
        serde_json::from_value::<Task>(saved.clone()).expect("restore routine state"),
        task
    );
    saved["identity"]["entry"] = serde_json::json!("review_entry");
    assert!(serde_json::from_value::<Task>(saved).is_err());
}

#[test]
fn a_forge_outage_does_not_charge_a_failure_and_new_heads_retire_retry_questions() {
    let mut task = task(Entry::ReviewEntry);
    let old_head = open('a', CheckState::Ready);
    let idle = retained(old_head.clone(), "reviewer", RetainedThread::Idle);
    start(
        &mut task,
        &old_head,
        Role::Reviewer,
        "reviewer",
        "first review",
    );
    for _ in 0..2 {
        let ended = host(&task, old_head.clone(), RunState::Ended);
        assert_eq!(task.reconcile(&ended), Action::Relaunch(Role::Reviewer));
        start(&mut task, &idle, Role::Reviewer, "reviewer", "retry review");
    }

    let outage = host(&task, observation(), RunState::Ended);
    assert_eq!(
        task.reconcile(&outage),
        Action::Wait(WaitReason::ForgeUnknown)
    );
    assert_eq!(task.attempts(), 2);
    assert_eq!(task.question(), None);

    let new_head = open('b', CheckState::Ready);
    let mut recovered = task.clone();
    let ended_at_new_head = host(&recovered, new_head.clone(), RunState::Ended);
    assert_eq!(
        recovered.reconcile(&ended_at_new_head),
        Action::Advance(Phase::Reviewing)
    );
    assert_eq!(recovered.attempts(), 0);
    assert_eq!(recovered.question(), None);

    let ended_at_old_head = host(&task, old_head, RunState::Ended);
    assert_eq!(
        task.reconcile(&ended_at_old_head),
        Action::Ask(Question::Retry {
            role: Role::Reviewer
        })
    );
    assert_eq!(task.attempts(), 3);
    assert_eq!(
        task.command(Command::Answer(Answer::Retry), &planner(), &outage),
        Err(CommandError::HeadUnverified)
    );
    assert_eq!(task.attempts(), 3);
    assert_eq!(
        task.command(Command::Answer(Answer::Retry), &planner(), &new_head),
        Err(CommandError::AnswerDoesNotMatch)
    );
    assert_eq!(task.reconcile(&new_head), Action::Advance(Phase::Reviewing));
    assert_eq!(task.attempts(), 0);
    assert_eq!(task.question(), None);
}

#[test]
fn a_prepared_review_rechecks_the_pr_and_worktree_without_charging_a_failure() {
    let mut task = task(Entry::ReviewEntry);
    let current = open('a', CheckState::Ready);
    start(
        &mut task,
        &current,
        Role::Reviewer,
        "reviewer",
        "prepared review",
    );
    let unknown_workspace = Observation {
        workspace: Observed::Unknown,
        ..current.clone()
    };
    let unknown = host(&task, unknown_workspace, RunState::ReadyToSend);
    assert_eq!(
        task.reconcile(&unknown),
        Action::Wait(WaitReason::WorkspaceUnknown)
    );
    assert!(task.run().is_some());

    let wrong_head = Observation {
        workspace: Observed::Known(Workspace::Clean(sha('b'))),
        ..current.clone()
    };
    let dirty = Observation {
        workspace: Observed::Known(Workspace::Dirty),
        ..current.clone()
    };
    let closed = Observation {
        forge: Observed::Known(Forge::Closed(pr('a'))),
        ..current
    };
    for invalid in [wrong_head, dirty, closed, open('b', CheckState::Ready)] {
        let mut task = task.clone();
        let ready = host(&task, invalid, RunState::ReadyToSend);
        assert_eq!(task.reconcile(&ready), Action::Advance(Phase::Reviewing));
        assert!(task.run().is_none());
        assert_eq!(task.attempts(), 0);
        assert_eq!(task.question(), None);
    }
}

#[test]
fn a_superseded_review_with_possible_delivery_is_revoked_until_quiescent() {
    let mut task = task(Entry::ReviewEntry);
    let current = open('a', CheckState::Ready);
    let bearer = start(&mut task, &current, Role::Reviewer, "reviewer", "review");
    let instance = task.run().expect("run").launch().instance.clone();
    task.record_send(&instance, 1)
        .expect("record possible send");
    let changed = open('b', CheckState::Ready);
    let ready = host(&task, changed.clone(), RunState::ReadyToSend);
    assert_eq!(task.reconcile(&ready), Action::Revoke);
    assert!(task.run().expect("stop must settle first").revoked());
    assert_eq!(task.attempts(), 0);
    let approval = Report::Review {
        head: sha('a'),
        decision: Review::Approve,
        summary: "old review".into(),
        finding_titles: Vec::new(),
    };
    assert_eq!(
        task.record_report(&instance, bearer.as_bytes(), approval),
        Err(CommandError::InvalidReportCredential)
    );
    let ended = host(&task, changed, RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
    assert!(task.run().is_none());
}

#[test]
fn a_reservation_after_move_cannot_restore_the_old_bearer() {
    let (mut task, obs) = working();
    let original = start(&mut task, &obs, Role::Worker, "worker", "same wire inputs");
    let prepared = task.run().expect("bound").launch().clone();
    let ready = host(&task, obs.clone(), RunState::ReadyToSend);
    assert_eq!(
        task.reconcile(&ready),
        Action::Launch {
            role: Role::Worker,
            via: Launch::SendPrepared
        }
    );
    assert_eq!(task.run().expect("still bound").launch(), &prepared);
    task.command(Command::Move(Phase::Working), &planner(), &obs)
        .expect("move");
    let ended = host(&task, obs.clone(), RunState::Ended);
    task.reconcile(&ended);
    let saved = serde_json::to_string(&task).expect("encode");
    let mut task: Task = serde_json::from_str(&saved).expect("restore counter");

    let idle = retained(obs, "worker", RetainedThread::Idle);
    let fresh = start(&mut task, &idle, Role::Worker, "worker", "same wire inputs");
    let current = instance(&task);
    assert_eq!(task.run().expect("bound").launch().label, prepared.label);
    assert_ne!(current, prepared.instance);
    assert_ne!(fresh.as_bytes(), original.as_bytes());
    for supplied in [&prepared.instance, &current] {
        assert_eq!(
            task.record_report(supplied, original.as_bytes(), Report::Work(pr('a').into())),
            Err(CommandError::InvalidReportCredential)
        );
    }
    report(&mut task, &fresh, Report::Work(pr('a').into()));
}

#[test]
fn a_settled_reviewer_report_survives_forge_outage_and_applies_to_a_fresh_merge() {
    let mut task = task(Entry::ReviewEntry);
    let bearer = start(
        &mut task,
        &open('a', CheckState::Ready),
        Role::Reviewer,
        "reviewer",
        "review",
    );
    report(
        &mut task,
        &bearer,
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Reviewed".into(),
            finding_titles: Vec::new(),
        },
    );
    let timeout = host(&task, observation(), RunState::Ended);
    assert_eq!(
        task.reconcile(&timeout),
        Action::Wait(WaitReason::ForgeUnknown)
    );
    assert_eq!(task.attempts(), 0);
    assert!(task.run().expect("waiting for forge").report().is_some());

    let merged = host(&task, merged('a', Workspace::Absent), RunState::Ended);
    assert_eq!(task.reconcile(&merged), Action::Advance(Phase::Closing));
    assert!(
        matches!(task.verdict(), Some(Verdict::Reviewed { head, decision: Review::Approve, .. }) if *head == sha('a'))
    );
    assert!(task.finish_close(&merged));
}

#[test]
fn confirmed_merge_recovery_continues_the_worker_and_requires_a_published_revision() {
    for (checks, expected) in [
        (CheckState::Conflict, "resolve the conflicts"),
        (CheckState::BaseMoved, "The base moved"),
        (
            CheckState::FailedRequired(vec!["Test / Linux".into()]),
            "Test / Linux",
        ),
    ] {
        let mut task = ready_for_merge();
        let stale = open('b', checks.clone());
        assert_eq!(decide(&task, &stale), Action::Advance(Phase::Reviewing));
        let blocked = open('a', checks);
        assert_eq!(task.reconcile(&blocked), Action::Advance(Phase::Working));
        let instruction = task
            .work_instruction()
            .expect("retained worker instruction");
        assert!(instruction.contains(expected), "{instruction}");
        assert!(instruction.contains(sha('a').as_str()));
        assert!(task.question().is_none());
        assert!(task.verdict().is_none());

        let idle = retained(blocked.clone(), "worker", RetainedThread::Idle);
        let credential = start(
            &mut task,
            &idle,
            Role::Worker,
            "worker",
            "frozen continuation",
        );
        let same = {
            let mut same = task.clone();
            report(&mut same, &credential, Report::Work(pr('a').into()));
            let ended = host(&same, blocked.clone(), RunState::Ended);
            assert_eq!(
                same.reconcile(&ended),
                Action::Ask(Question::Repair(Repair::RevisionHasSameHead))
            );
            same
        };
        assert_eq!(decide(&same, &blocked), Action::Wait(WaitReason::Question));

        let fresh = open('b', CheckState::Ready);
        report(&mut task, &credential, Report::Work(pr('b').into()));
        let ended = host(&task, fresh.clone(), RunState::Ended);
        assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
        assert!(task.work_instruction().is_none());
        assert_eq!(
            task.command(Command::Move(Phase::Merging), &planner(), &fresh),
            Err(CommandError::MergeAuthorityRequired)
        );
    }
}

#[test]
fn a_legacy_merge_blocked_answer_uses_the_code_owner_continuation() {
    let mut task = ready_for_merge();
    let blocked = open('a', CheckState::Blocked);
    assert_eq!(
        task.reconcile(&blocked),
        Action::Ask(Question::Repair(Repair::MergeBlocked))
    );
    let instruction = "Rebase and report the published head";
    assert_eq!(
        task.command(
            Command::Answer(Answer::Work(instruction.into())),
            &planner(),
            &open('b', CheckState::Ready),
        ),
        Err(CommandError::AnswerDoesNotMatch)
    );
    task.command(
        Command::Answer(Answer::Work(instruction.into())),
        &planner(),
        &blocked,
    )
    .expect("apply existing question's work answer");
    assert_eq!(task.phase(), Phase::Working);
    assert_eq!(task.work_instruction(), Some(instruction));
    assert!(task.question().is_none());
    let idle = retained(blocked, "worker", RetainedThread::Idle);
    assert_eq!(
        decide(&task, &idle),
        Action::Launch {
            role: Role::Worker,
            via: Launch::Continue {
                thread: "worker".into()
            }
        }
    );

    let gate = open('a', CheckState::Unreported);
    assert_eq!(
        decide(&ready_for_merge(), &gate),
        Action::Wait(WaitReason::ChecksUnreported)
    );
}
