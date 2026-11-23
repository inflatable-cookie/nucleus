use nucleus_core::{
    Action, Answer, Authority, CheckState, CloseWorkspace, Command, CommandError, CredentialDigest,
    Entry, Forge, Head, Host, Identity, Launch, Observation, Observed, Phase, PreparedLaunch,
    PullRequest, Question, Repair, Report, RetainedThread, Review, Role, RunState, Task, Verdict,
    WaitReason, Workspace, decide,
};

const CREDENTIAL: CredentialDigest = CredentialDigest([7; 32]);

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

fn start(task: &mut Task, obs: &Observation, role: Role, thread: &str, instance: &str) {
    let review_head = match &obs.forge {
        Observed::Known(Forge::Open { pr, .. }) if role == Role::Reviewer => Some(pr.head.clone()),
        _ => None,
    };
    task.reserve_launch(
        obs,
        PreparedLaunch {
            instance: instance.into(),
            thread: thread.into(),
            role,
            label: "fixture-label".into(),
            started_at: 1,
            credential: CREDENTIAL,
            input: "immutable wire body".into(),
            review_head,
        },
    )
    .expect("reserve launch");
}

fn report(task: &mut Task, value: Report) {
    let instance = task.run().expect("bound run").launch().instance.clone();
    task.record_report(&instance, &CREDENTIAL, value)
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
    start(&mut task, &obs, Role::Worker, "worker", "work-1");
    report(&mut task, Report::Work(pr('a')));
    let review = open('a', CheckState::Pending);
    let ended = host(&task, review.clone(), RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
    start(&mut task, &review, Role::Reviewer, "reviewer", "review-1");
    report(
        &mut task,
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Matches brief".into(),
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
        decide(&task, &open('a', CheckState::Ready)),
        Action::Ask(Question::Repair(Repair::MergeUnconfirmed))
    );
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
        Err(CommandError::MergeAuthorityRequired)
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
    assert_eq!(task.threads().get(Role::Reviewer), Some("replacement"));
}

#[test]
fn a_stale_review_report_waits_for_the_turn_to_settle_then_refreshes_the_head() {
    let mut task = task(Entry::ReviewEntry);
    start(
        &mut task,
        &open('a', CheckState::Ready),
        Role::Reviewer,
        "reviewer",
        "review-1",
    );
    report(
        &mut task,
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Reviewed".into(),
        },
    );
    let changed = open('b', CheckState::Ready);
    assert_eq!(
        decide(&task, &host(&task, changed.clone(), RunState::Running)),
        Action::Wait(WaitReason::Running)
    );
    let ended = host(&task, changed, RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Reviewing));
    assert_eq!(task.pull_request(), Some(&pr('b')));
    assert_eq!(task.verdict(), None);
}

#[test]
fn changes_continue_the_worker_and_require_a_new_head() {
    let (mut task, obs) = working();
    start(&mut task, &obs, Role::Worker, "worker", "work-1");
    report(&mut task, Report::Work(pr('a')));
    let review = open('a', CheckState::Ready);
    let ended = host(&task, review.clone(), RunState::Ended);
    task.reconcile(&ended);
    start(&mut task, &review, Role::Reviewer, "reviewer", "review-1");
    report(
        &mut task,
        Report::Review {
            head: sha('a'),
            decision: Review::Changes,
            summary: "Add handling for empty input".into(),
        },
    );
    let ended = host(&task, review.clone(), RunState::Ended);
    assert_eq!(task.reconcile(&ended), Action::Advance(Phase::Working));
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
    start(&mut task, &worker, Role::Worker, "worker", "work-2");
    report(&mut task, Report::Work(pr('a')));
    let ended = host(&task, review, RunState::Ended);
    assert_eq!(
        task.reconcile(&ended),
        Action::Ask(Question::Repair(Repair::RevisionHasSameHead))
    );
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
    assert_eq!(task.run().expect("reserved").launch().instance, "work-1");
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
        start(&mut task, &idle, Role::Worker, "worker", "work-2");
        task.command(command, &planner(), &obs).expect("revoke");
        assert_eq!(task.phase(), phase);
        assert_eq!(task.attempts(), 0);
        assert!(task.run().expect("still bound").revoked());
        assert_eq!(
            task.record_report("work-2", &CREDENTIAL, Report::Work(pr('a'))),
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
            assert_eq!(task.run().expect("fresh run").launch().instance, "work-3");
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
    start(&mut task, &obs, Role::Worker, "worker", "work-1");
    let question = Report::Question {
        prompt: "Which spelling?".into(),
        options: vec!["UK".into(), "US".into()],
    };
    let prior_digest = task.brief().digest;
    report(&mut task, question.clone());
    report(&mut task, question);
    assert_eq!(
        task.record_report("work-1", &CREDENTIAL, Report::Work(pr('a'))),
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
            Action::Launch {
                role: Role::Reviewer,
                via: Launch::Create,
            },
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
        decide(&task, &closed),
        Action::Ask(Question::Repair(Repair::PullRequestUnavailable))
    );
    start(&mut task, &open, Role::Reviewer, "reviewer", "review-1");
    let report = Report::Review {
        head: sha('b'),
        decision: Review::Approve,
        summary: "Wrong head".into(),
    };
    assert_eq!(
        task.record_report("review-1", &CredentialDigest([0; 32]), report.clone()),
        Err(CommandError::InvalidReportCredential)
    );
    assert_eq!(
        task.record_report("review-1", &CREDENTIAL, report),
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
