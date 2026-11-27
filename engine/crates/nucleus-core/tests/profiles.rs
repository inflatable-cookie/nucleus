use std::collections::VecDeque;

use nucleus_core::profiles::{
    BriefPolicy, Candidate, Capability, Complexity, Effort, LaunchPolicy, Profile, ProfileLaunch,
    ProfileLaunchError, Provider, RotationCounts, UsageLevel, Weight, decide_profile_launch,
    decide_weighted_launch, own_bracket, pending_complexity_reselection, request_only,
    requested_bracket, reviewer_bracket, worker_climb, worker_start,
};
use nucleus_core::{
    Action, Authority, CallbackCredential, CheckState, Command, CommandError, Entry, Forge, Host,
    Identity, Launch, LaunchInputs, Observation, Observed, Phase, PullRequest, Report,
    RetainedThread, Review, Role, RunState, Task, Workspace, decide,
};

use Capability::{Frontier, Heavyweight, Mechanical, Worker};
use Complexity::{High, Low, Medium, VeryHigh, VeryLow};
use UsageLevel::{ExtraHigh, Maximum, Normal};

const USAGES: [UsageLevel; 5] = [
    UsageLevel::Low,
    Normal,
    UsageLevel::High,
    ExtraHigh,
    Maximum,
];
const COMPLEXITIES: [Complexity; 5] = [VeryLow, Low, Medium, High, VeryHigh];
const BRACKETS: [Capability; 4] = [Mechanical, Worker, Heavyweight, Frontier];

#[test]
fn each_worker_start_and_reviewer_cell_matches_spec_052() {
    let starts = [
        [Mechanical, Mechanical, Mechanical, Worker, Heavyweight],
        [Mechanical, Mechanical, Worker, Worker, Heavyweight],
        [Mechanical, Mechanical, Worker, Heavyweight, Heavyweight],
        [Mechanical, Mechanical, Worker, Heavyweight, Heavyweight],
        [Worker, Worker, Heavyweight, Heavyweight, Frontier],
    ];
    let reviews = [
        [Mechanical, Mechanical, Worker, Heavyweight],
        [Mechanical, Mechanical, Worker, Heavyweight],
        [Mechanical, Worker, Worker, Heavyweight],
        [Mechanical, Worker, Heavyweight, Frontier],
        [Mechanical, Worker, Heavyweight, Frontier],
    ];
    assert_eq!(
        COMPLEXITIES.map(own_bracket),
        [Mechanical, Mechanical, Worker, Worker, Heavyweight]
    );
    assert_eq!(
        COMPLEXITIES.map(requested_bracket),
        [Mechanical, Mechanical, Worker, Heavyweight, Frontier]
    );
    for (row, usage) in USAGES.into_iter().enumerate() {
        for (column, complexity) in COMPLEXITIES.into_iter().enumerate() {
            assert_eq!(
                worker_start(usage, complexity),
                starts[row][column],
                "{usage:?}/{complexity:?}"
            );
        }
        assert_eq!(worker_start(usage, Complexity::default()), starts[row][2]);
        for (column, worker) in BRACKETS.into_iter().enumerate() {
            assert_eq!(
                reviewer_bracket(usage, worker, false),
                reviews[row][column],
                "{usage:?}/{worker:?}"
            );
            assert_eq!(
                reviewer_bracket(usage, worker, true),
                worker,
                "critical {usage:?}/{worker:?}"
            );
        }
    }
}

#[test]
fn climb_targets_and_permission_bounds_match_spec_052() {
    for (usage, complexity, actual, expected) in [
        (UsageLevel::Low, VeryLow, Mechanical, None),
        (UsageLevel::Low, Medium, Mechanical, Some(Worker)),
        (UsageLevel::Low, High, Worker, Some(Heavyweight)),
        (Normal, Low, Mechanical, None),
        (Normal, Medium, Worker, None),
        (Normal, High, Mechanical, Some(Worker)),
        (Normal, High, Worker, Some(Heavyweight)),
        (Normal, VeryHigh, Heavyweight, None),
        (UsageLevel::High, High, Worker, None),
        (UsageLevel::High, VeryHigh, Heavyweight, None),
        (ExtraHigh, VeryHigh, Heavyweight, Some(Frontier)),
        (Maximum, VeryLow, Mechanical, None),
        (Maximum, Low, Mechanical, None),
        (Maximum, Medium, Worker, None),
        (Maximum, High, Heavyweight, Some(Frontier)),
        (Maximum, High, Frontier, None),
        (Maximum, VeryHigh, Heavyweight, None),
    ] {
        assert_eq!(
            worker_climb(usage, complexity, actual),
            expected,
            "{usage:?}/{complexity:?}/{actual:?}"
        );
    }
    for (level, restricted) in USAGES.into_iter().zip([true, true, true, false, false]) {
        for complexity in COMPLEXITIES {
            assert_eq!(request_only(Frontier, level, complexity, None), restricted);
            assert_eq!(
                request_only(Heavyweight, level, complexity, None),
                matches!(level, UsageLevel::Low | Normal) && complexity != VeryHigh
            );
            assert!(!request_only(
                Heavyweight,
                level,
                complexity,
                Some(Heavyweight)
            ));
            assert!(!request_only(Worker, level, complexity, None));
        }
    }
}

const REQUESTS: &str = concat!(
    "title: Profile proof\r\n",
    "queue:\r\n",
    "  complexity: very_high\r\n",
    "  critical: true\r\n",
    "  profileRequests:\r\n",
    "    worker: {profileId: ' frontier ', reason: ' closer analysis ', required: true, thinkingOptionId: xhigh}\r\n",
    "    reviewer:\r\n",
    "      profileId: independent\r\n",
    "      reason: >-\r\n",
    "        independent\r\n",
    "        review\r\n",
    "    coordinator: {profileId: obsolete}\r\n",
);

#[test]
fn config_and_brief_use_the_existing_canonical_vocabulary() {
    assert_eq!(
        serde_json::from_str::<UsageLevel>(r#""minimal""#).unwrap(),
        UsageLevel::Low
    );
    for (capability, canonical) in
        BRACKETS
            .into_iter()
            .zip(["mechanical", "worker", "heavyweight", "frontier"])
    {
        assert_eq!(serde_json::to_value(capability).unwrap(), canonical);
    }
    for (legacy, capability) in [
        ("very_low", Mechanical),
        ("low", Mechanical),
        ("medium", Worker),
        ("high", Worker),
        ("very_high", Heavyweight),
    ] {
        assert_eq!(
            serde_json::from_value::<Capability>(legacy.into()).unwrap(),
            capability
        );
    }
    assert_eq!(
        BriefPolicy::parse("Plain brief.").unwrap(),
        BriefPolicy::default()
    );
    assert_eq!(
        BriefPolicy::parse("---\n---\nBody").unwrap(),
        BriefPolicy::default()
    );
    let parsed = BriefPolicy::parse(&format!("---\r\n{REQUESTS}---\r\nBody")).unwrap();
    assert_eq!(parsed.complexity, Some(VeryHigh));
    assert!(parsed.critical);
    let request = parsed.request(Role::Worker).unwrap();
    assert_eq!(request.profile_id, "frontier");
    assert_eq!(request.reason, "closer analysis");
    assert_eq!(request.thinking_option_id, Some(Effort::XHigh));
    assert!(request.required);
    assert_eq!(
        parsed.request(Role::Reviewer).unwrap().reason,
        "independent review"
    );

    for invalid in [
        "---\nqueue:\n  critical: perhaps\n---\nbody",
        "---\nqueue:\n  complexity: medium\n  complexity: high\n---\nbody",
        "---\nqueue:\n  profileRequests:\n    worker: {profileId: frontier, reason: '  '}\n---\nbody",
        "---\nqueue:\n  profileRequests:\n    worker: {profileId: frontier}\n---\nbody",
        "---\nqueue:\n  profileRequests:\n    worker: {profileId: frontier, reason: true}\n---\nbody",
        "---\nqueue:\n  profileRequests:\n    worker: {profileId: 123, reason: analysis}\n---\nbody",
        "---\nqueue:\n  complexity: low",
    ] {
        assert!(BriefPolicy::parse(invalid).is_err(), "{invalid}");
    }
}

fn profile(id: &str, capability: Capability) -> Profile {
    Profile {
        id: id.into(),
        capability,
        weight: Weight::Default,
        provider: Provider::Codex,
        model: format!("model-{id}"),
        effort: None,
    }
}

fn candidate(profile: &Profile) -> Candidate<'_> {
    Candidate {
        profile,
        enabled: true,
        available: true,
        group_available: true,
        supported_efforts: &[Effort::XHigh],
        counts: RotationCounts::default(),
    }
}

fn task(brief: &str, entry: Entry) -> Task {
    Task::new(
        Identity {
            id: "profile-test".into(),
            reference: "fixture#1".into(),
            repository: "host/fixture".into(),
            base: "main".into(),
            entry,
            origin_thread: Some("fixture-planner".into()),
        },
        brief.into(),
        (entry == Entry::ReviewEntry).then(|| pr('a')),
    )
}

fn pr(digit: char) -> PullRequest {
    PullRequest {
        url: "https://github.com/host/fixture/pull/1".into(),
        head: digit.to_string().repeat(40).parse().unwrap(),
    }
}

fn unbound() -> Observation {
    Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Absent),
    }
}

fn open(digit: char) -> Observation {
    let pr = pr(digit);
    Observation {
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(pr.head.clone())),
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
    }
}

fn role_thread(obs: Observation, thread: &str, state: RetainedThread) -> Observation {
    Observation {
        host: Observed::Known(Host::Retained {
            thread: thread.into(),
            state,
        }),
        ..obs
    }
}

fn working(brief: &str) -> Task {
    let mut task = task(brief, Entry::Brief);
    assert_eq!(task.reconcile(&unbound()), Action::Advance(Phase::Working));
    task
}

#[test]
fn history_free_selection_uses_weights_inside_the_eligible_bracket() {
    let mut small = profile("small", Worker);
    small.weight = Weight::Fewest;
    let mut large = profile("large", Worker);
    large.weight = Weight::Most;
    let outside = profile("outside", Heavyweight);
    let candidates = [candidate(&small), candidate(&large), candidate(&outside)];
    let policy = LaunchPolicy {
        usage: Normal,
        candidates: &candidates,
        planner_brief: true,
        author_models: &[],
    };
    let task = working("Add a greeting.");
    let observation = unbound();
    for (sample, expected) in [
        (0, "small"),
        (49, "small"),
        (50, "large"),
        (249, "large"),
        (250, "small"),
    ] {
        let launch = decide_weighted_launch(&task, &observation, &policy, sample)
            .expect("select from the working bracket")
            .expect("launch");
        assert_eq!(launch.profile().id, expected);
    }
}

fn pick(
    task: &Task,
    obs: &Observation,
    usage: UsageLevel,
    pool: &[Candidate<'_>],
) -> ProfileLaunch {
    select(task, obs, usage, pool).unwrap().expect("new launch")
}

fn select(
    task: &Task,
    obs: &Observation,
    usage: UsageLevel,
    pool: &[Candidate<'_>],
) -> Result<Option<ProfileLaunch>, ProfileLaunchError> {
    decide_profile_launch(
        task,
        obs,
        &LaunchPolicy {
            usage,
            candidates: pool,
            planner_brief: true,
            author_models: &[],
        },
    )
}

#[test]
fn a_paused_mechanical_reviewer_steps_up_to_an_independent_worker() {
    let luna = profile("luna-mechanic", Mechanical);
    let muse = profile("muse-mechanic", Mechanical);
    let peer = profile("peer-worker", Worker);
    let author = Profile {
        model: luna.model.clone(),
        ..profile("author-worker", Worker)
    };
    let mut task = working("Fix a typo.");
    finish_worker(&mut task, &luna);
    let mut pool = [
        candidate(&luna),
        candidate(&muse),
        candidate(&author),
        candidate(&peer),
    ];
    let obs = open('a');
    pool[1].group_available = false;

    for usage in USAGES {
        let stepped = pick(&task, &obs, usage, &pool);
        assert_eq!(stepped.profile(), &peer);
        assert_eq!(stepped.step_up_from(), Some(Mechanical));
    }
    pool[1].group_available = true;
    for usage in USAGES {
        let ordinary = pick(&task, &obs, usage, &pool);
        assert_eq!(ordinary.profile(), &muse);
        assert_eq!(ordinary.step_up_from(), None);
    }

    review_changes(&mut task, &obs, &muse);
    let obs = role_thread(obs, "reviewer-1", RetainedThread::Idle);
    task.command(
        Command::Move(Phase::Reviewing),
        &Authority::Planner {
            actor: "fixture-planner".into(),
        },
        &obs,
    )
    .unwrap();
    assert!(matches!(
        pick(&task, &obs, Normal, &pool).via(),
        Launch::Continue { .. }
    ));

    pool[1].group_available = false;
    let replacement = pick(&task, &obs, Normal, &pool);
    assert_eq!(replacement.profile(), &peer);
    assert_eq!(replacement.step_up_from(), Some(Mechanical));
    assert_eq!(replacement.via(), &Launch::Create);
    assert_eq!(replacement.replaced_thread(), Some("reviewer-1"));
}

#[test]
fn a_pause_can_skip_multiple_tiers_within_the_usage_level_request_rules() {
    let luna = profile("luna-mechanic", Mechanical);
    let muse = profile("muse-mechanic", Mechanical);
    let worker = profile("worker", Worker);
    let heavyweight = profile("heavyweight", Heavyweight);
    let frontier = profile("frontier", Frontier);
    let mut task = working("---\nqueue: {complexity: low}\n---\nFix a typo.");
    finish_worker(&mut task, &luna);
    let obs = open('a');
    let paused = |profile| Candidate {
        group_available: false,
        ..candidate(profile)
    };
    let pool = [
        paused(&muse),
        paused(&worker),
        candidate(&heavyweight),
        candidate(&frontier),
    ];
    assert_eq!(
        pick(&task, &obs, UsageLevel::High, &pool).profile(),
        &heavyweight
    );
    for usage in [UsageLevel::Low, Normal] {
        assert!(matches!(
            select(&task, &obs, usage, &pool),
            Err(ProfileLaunchError::NoEligibleProfile {
                role: Role::Reviewer,
                ..
            })
        ));
    }
    let pool = [
        paused(&muse),
        paused(&worker),
        paused(&heavyweight),
        candidate(&frontier),
    ];
    assert!(matches!(
        select(&task, &obs, UsageLevel::High, &pool),
        Err(ProfileLaunchError::NoEligibleProfile {
            role: Role::Reviewer,
            ..
        })
    ));
    for usage in [ExtraHigh, Maximum] {
        assert_eq!(pick(&task, &obs, usage, &pool).profile(), &frontier);
        assert!(matches!(
            select(&task, &obs, usage, &pool[1..]),
            Err(ProfileLaunchError::NoEligibleProfile {
                role: Role::Reviewer,
                ..
            })
        ));
    }
}

#[test]
fn a_required_reviewer_still_waits_for_its_paused_group() {
    let luna = profile("luna-mechanic", Mechanical);
    let muse = profile("muse-mechanic", Mechanical);
    let peer = profile("peer-worker", Worker);
    let mut task = working(
        "---\nqueue: {complexity: low, profileRequests: {reviewer: {profileId: muse-mechanic, reason: independent, required: true}}}\n---\nFix a typo.",
    );
    finish_worker(&mut task, &luna);
    let pool = [
        Candidate {
            group_available: false,
            ..candidate(&muse)
        },
        candidate(&peer),
    ];
    assert!(matches!(
        select(&task, &open('a'), Normal, &pool),
        Err(ProfileLaunchError::RequiredProfileUnavailable { role: Role::Reviewer, id })
            if id == muse.id
    ));
}

#[test]
fn frontier_is_explicit_below_extra_high_and_the_request_is_role_scoped() {
    let frontier = profile("frontier", Frontier);
    let peer = profile("independent", Heavyweight);
    let worker = working(&format!("---\r\n{REQUESTS}---\r\nBody"));
    let automatic = working("---\nqueue: {complexity: very_high}\n---\nBody");
    let pool = [candidate(&frontier), candidate(&peer)];
    for usage in [UsageLevel::Low, Normal, UsageLevel::High] {
        assert!(matches!(
            decide_profile_launch(
                &automatic,
                &unbound(),
                &LaunchPolicy {
                    usage,
                    candidates: &[candidate(&frontier)],
                    planner_brief: true,
                    author_models: &[],
                }
            ),
            Err(ProfileLaunchError::NoEligibleProfile {
                role: Role::Worker,
                ..
            })
        ));
        let chosen = pick(&worker, &unbound(), usage, &pool);
        assert_eq!(chosen.profile().id, frontier.id);
        assert_eq!(chosen.profile().effort, Some(Effort::XHigh));
        assert_eq!(chosen.request_reason(), Some("closer analysis"));
        assert_eq!(
            pick(&automatic, &unbound(), usage, &pool).profile().id,
            peer.id
        );
        let ignored = decide_profile_launch(
            &worker,
            &unbound(),
            &LaunchPolicy {
                usage,
                candidates: &pool,
                planner_brief: false,
                author_models: &[],
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(ignored.profile().id, peer.id);

        let unavailable = [
            Candidate {
                supported_efforts: &[],
                ..candidate(&frontier)
            },
            candidate(&peer),
        ];
        assert!(matches!(
            decide_profile_launch(
                &worker,
                &unbound(),
                &LaunchPolicy {
                    usage,
                    candidates: &unavailable,
                    planner_brief: true,
                    author_models: &[],
                }
            ),
            Err(ProfileLaunchError::RequiredProfileUnavailable {
                role: Role::Worker,
                ..
            })
        ));
    }
    assert_eq!(
        pick(&automatic, &unbound(), Maximum, &pool).profile().id,
        frontier.id
    );
    assert_eq!(
        pick(&automatic, &unbound(), ExtraHigh, &[candidate(&frontier)]).profile(),
        &frontier
    );
    let reviewer_only = working(
        "---\nqueue: {complexity: very_high, profileRequests: {reviewer: {profileId: frontier, reason: review}}}\n---\nBody",
    );
    assert_eq!(
        pick(&reviewer_only, &unbound(), Normal, &pool).profile().id,
        peer.id
    );
}

fn reserve(
    task: &mut Task,
    obs: &Observation,
    intent: ProfileLaunch,
    thread: &str,
) -> (String, CallbackCredential) {
    let instance = intent.instance().to_owned();
    let bearer = task
        .reserve_profile_launch(
            obs,
            LaunchInputs {
                scratch: None,
                thread: thread.into(),
                started_at: 1,
                input: format!("immutable native wire {instance}"),
            },
            &[7; 32],
            intent,
        )
        .unwrap();
    (instance, bearer)
}

fn current(obs: Observation, instance: &str, state: RunState) -> Observation {
    Observation {
        host: Observed::Known(Host::Current {
            instance: instance.into(),
            state,
        }),
        ..obs
    }
}

fn finish_worker(task: &mut Task, worker: &Profile) {
    let obs = unbound();
    let first = pick(task, &obs, Normal, &[candidate(worker)]);
    let (instance, bearer) = reserve(task, &obs, first, "worker-1");
    task.record_send(&instance, 2).unwrap();
    task.record_report(&instance, bearer.as_bytes(), Report::Work(pr('a').into()))
        .unwrap();
    assert_eq!(
        task.reconcile(&current(open('a'), &instance, RunState::Ended)),
        Action::Advance(Phase::Reviewing)
    );
}

fn review_changes(task: &mut Task, obs: &Observation, reviewer: &Profile) {
    let intent = pick(task, obs, Normal, &[candidate(reviewer)]);
    let (instance, bearer) = reserve(task, obs, intent, "reviewer-1");
    task.record_send(&instance, 2).unwrap();
    task.record_report(
        &instance,
        bearer.as_bytes(),
        Report::Review {
            head: pr('a').head,
            decision: Review::Changes,
            summary: "Fix the race in the revision path.".into(),
            finding_titles: Vec::new(),
        },
    )
    .unwrap();
    assert_eq!(
        task.reconcile(&current(open('a'), &instance, RunState::Ended)),
        Action::Advance(Phase::Working)
    );
}

#[test]
fn applied_changes_request_a_fresh_child_and_are_consumed_once_across_replay() {
    let mut task = working("---\nqueue: {complexity: high}\n---\nFix the issue.");
    let initial = profile("initial", Mechanical);
    let reviewer = profile("reviewer", Mechanical);
    let next = profile("next", Worker);
    let heavy = profile("heavy", Heavyweight);
    let pool = [candidate(&initial), candidate(&next), candidate(&heavy)];
    finish_worker(&mut task, &initial);
    review_changes(&mut task, &open('a'), &reviewer);
    let obs = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    let intent = pick(&task, &obs, Normal, &pool);
    assert_eq!(intent.profile(), &next);
    assert_eq!(intent.via(), &Launch::Create);
    assert_eq!(intent.replaced_thread(), Some("worker-1"));
    assert_eq!(intent.pull_request(), Some(&pr('a')));
    assert_eq!(intent.brief().text, task.brief().text);
    assert_eq!(
        intent.findings(),
        Some("Fix the race in the revision path.")
    );
    assert_eq!(
        task.reserve_profile_launch(
            &obs,
            LaunchInputs {
                scratch: None,
                thread: "worker-1".into(),
                started_at: 1,
                input: "bad child".into(),
            },
            &[7; 32],
            intent.clone()
        )
        .unwrap_err(),
        CommandError::LaunchNoLongerApplies
    );

    let (instance, _) = reserve(&mut task, &obs, intent, "worker-2");
    assert_eq!(task.threads().profile(Role::Worker), Some(&initial));
    let mut task: Task = serde_json::from_str(&serde_json::to_string(&task).unwrap()).unwrap();
    let launch = task.run().unwrap().launch().clone();
    let replay = current(open('a'), &instance, RunState::ReadyToSend);
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    task.command(
        Command::Amend(format!("{}\n\nExtra context.", task.brief().text)),
        &planner,
        &replay,
    )
    .unwrap();
    assert_eq!(
        decide(&task, &replay),
        Action::Launch {
            role: Role::Worker,
            via: Launch::SendPrepared
        }
    );
    // Changed settings/candidates do not replace a previously frozen request.
    assert!(
        decide_profile_launch(
            &task,
            &replay,
            &LaunchPolicy {
                usage: Maximum,
                candidates: &[],
                planner_brief: false,
                author_models: &[],
            }
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(task.run().unwrap().launch(), &launch);
    assert_eq!(launch.profile(), Some(&next));
    task.record_send(&instance, 3).unwrap();
    assert_eq!(task.threads().profile(Role::Worker), Some(&next));
    assert_eq!(
        task.reconcile(&current(open('a'), &instance, RunState::Gone)),
        Action::Relaunch(Role::Worker)
    );

    for state in [RetainedThread::Idle, RetainedThread::Gone] {
        let retry = role_thread(open('a'), "worker-2", state);
        let selected = pick(&task, &retry, Maximum, &pool);
        assert_eq!(selected.profile(), &next);
        assert_eq!(
            selected.findings(),
            Some("Fix the race in the revision path.")
        );
    }

    let review = role_thread(open('a'), "reviewer-1", RetainedThread::Idle);
    task.command(Command::Move(Phase::Reviewing), &planner, &review)
        .unwrap();
    review_changes(&mut task, &review, &reviewer);
    let second = pick(
        &task,
        &role_thread(open('a'), "worker-2", RetainedThread::Idle),
        Normal,
        &pool,
    );
    assert_eq!(second.profile(), &heavy);
    assert_eq!(second.replaced_thread(), Some("worker-2"));
}

#[test]
fn complexity_amendments_route_legacy_retained_workers_on_their_next_selection() {
    let luna = profile("luna", Mechanical);
    let worker = profile("worker", Worker);
    let sol = profile("sol", Heavyweight);
    let reviewer = profile("reviewer", Mechanical);
    let pool = [candidate(&luna), candidate(&worker), candidate(&sol)];
    let obs = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    for (before, after, retained, expected, replacement) in [
        ("low", "very_high", &luna, &sol, true),
        ("very_high", "low", &sol, &sol, false),
        ("low", "low", &luna, &luna, false),
        (
            "low",
            "very_high, profileRequests: {worker: {profileId: worker, reason: fixture, required: true}}",
            &luna,
            &worker,
            true,
        ),
    ] {
        let mut task = working(&format!(
            "---\nqueue: {{complexity: {before}}}\n---\nFix it."
        ));
        finish_worker(&mut task, retained);
        review_changes(&mut task, &open('a'), &reviewer);
        let mut row = serde_json::to_value(&task).unwrap();
        let bound = row["threads"]["worker_profile"].as_object_mut().unwrap();
        bound.remove("complexity");
        bound.remove("brief_version");
        let mut task: Task = serde_json::from_value(row).unwrap();
        task.command(
            Command::Amend(format!(
                "---\nqueue: {{complexity: {after}}}\n---\nFix this."
            )),
            &planner,
            &obs,
        )
        .unwrap();
        let mut task: Task = serde_json::from_value(serde_json::to_value(task).unwrap()).unwrap();
        assert_eq!(
            pending_complexity_reselection(&task, Role::Worker, Normal),
            (after == "very_high").then_some((Mechanical, Heavyweight))
        );
        let intent = pick(&task, &obs, Normal, &pool);
        assert_eq!(intent.profile(), expected);
        assert_eq!(intent.replaced_thread(), replacement.then_some("worker-1"));
        assert_eq!(intent.pull_request(), Some(&pr('a')));
        assert_eq!(
            intent.findings(),
            Some("Fix the race in the revision path.")
        );
        assert_eq!(intent.brief(), task.brief());

        let thread = if replacement { "worker-2" } else { "worker-1" };
        let (instance, _) = reserve(&mut task, &obs, intent, thread);
        task.record_send(&instance, 2).unwrap();
        assert!(pending_complexity_reselection(&task, Role::Worker, Normal).is_none());
        assert_eq!(
            task.reconcile(&current(open('a'), &instance, RunState::Gone)),
            Action::Relaunch(Role::Worker)
        );
        let retry = role_thread(open('a'), thread, RetainedThread::Idle);
        assert_eq!(pick(&task, &retry, Normal, &pool).profile(), expected);
    }
}

#[test]
fn a_raise_during_a_prepared_send_is_seen_by_each_roles_next_reservation() {
    let luna = profile("luna", Mechanical);
    let reviewer = profile("reviewer", Mechanical);
    let sol = profile("sol", Heavyweight);
    let stronger_reviewer = profile("stronger-reviewer", Worker);
    let pool = [
        candidate(&luna),
        candidate(&reviewer),
        candidate(&sol),
        candidate(&stronger_reviewer),
    ];
    let mut task = working("---\nqueue: {complexity: low}\n---\nFix it.");
    finish_worker(&mut task, &luna);
    review_changes(&mut task, &open('a'), &reviewer);
    let obs = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    let old = pick(&task, &obs, Normal, &pool);
    let (instance, _) = reserve(&mut task, &obs, old, "worker-1");
    let frozen = task.run().unwrap().launch().clone();
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    let ready = current(open('a'), &instance, RunState::ReadyToSend);
    for (complexity, rest) in [("very_high", "Fix it."), ("very_high", "Fix this.")] {
        task.command(
            Command::Amend(format!(
                "---\nqueue: {{complexity: {complexity}}}\n---\n{rest}"
            )),
            &planner,
            &ready,
        )
        .unwrap();
    }
    assert!(select(&task, &ready, Normal, &pool).unwrap().is_none());
    assert_eq!(task.run().unwrap().launch(), &frozen);
    task.record_send(&instance, 2).unwrap();
    assert_eq!(
        task.reconcile(&current(open('a'), &instance, RunState::Gone)),
        Action::Relaunch(Role::Worker)
    );
    let replacement = pick(&task, &obs, Normal, &pool);
    assert_eq!(replacement.profile(), &sol);
    let (instance, bearer) = reserve(&mut task, &obs, replacement, "worker-2");
    task.record_send(&instance, 2).unwrap();
    task.record_report(&instance, bearer.as_bytes(), Report::Work(pr('b').into()))
        .unwrap();
    assert_eq!(
        task.reconcile(&current(open('b'), &instance, RunState::Ended)),
        Action::Advance(Phase::Reviewing)
    );

    assert_eq!(
        pending_complexity_reselection(&task, Role::Reviewer, Normal),
        Some((Mechanical, Worker))
    );
    let review = role_thread(open('b'), "reviewer-1", RetainedThread::Idle);
    let next = pick(&task, &review, Normal, &pool);
    assert_eq!(next.profile(), &stronger_reviewer);
    assert_eq!(next.replaced_thread(), Some("reviewer-1"));
    assert_eq!(next.pull_request(), Some(&pr('b')));
}

#[test]
fn phase_moves_and_a_stale_verdict_do_not_authorize_a_climb() {
    let brief = "---\nqueue: {complexity: high}\n---\nFix the issue.";
    let initial = profile("worker", Worker);
    let reviewer = profile("reviewer", Mechanical);
    let heavy = profile("heavy", Heavyweight);
    let pool = [candidate(&initial), candidate(&heavy)];
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };

    let mut moved = working(brief);
    finish_worker(&mut moved, &initial);
    let obs = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    moved
        .command(Command::Move(Phase::Working), &planner, &obs)
        .unwrap();
    let ordinary = pick(&moved, &obs, Normal, &pool);
    assert_eq!(ordinary.profile(), &initial);
    assert_eq!(ordinary.findings(), None);
    assert_eq!(
        ordinary.via(),
        &Launch::Continue {
            thread: "worker-1".into()
        }
    );

    let mut stale = working(brief);
    finish_worker(&mut stale, &initial);
    review_changes(&mut stale, &open('a'), &reviewer);
    let new_head = role_thread(open('b'), "worker-1", RetainedThread::Idle);
    assert_eq!(stale.reconcile(&new_head), Action::Advance(Phase::Working));
    let ordinary = pick(&stale, &new_head, Normal, &pool);
    assert_eq!(ordinary.profile(), &initial);
    assert_eq!(ordinary.findings(), None);
    assert_eq!(ordinary.pull_request(), Some(&pr('b')));
}

#[test]
fn critical_review_prefers_the_actual_workers_bracket_and_falls_back() {
    let worker = profile("actual-heavy", Heavyweight);
    let mut shares_model = profile("same-model", Heavyweight);
    shares_model.model = format!("gateway/{}", worker.model.to_ascii_uppercase());
    let independent = profile("independent-heavy", Heavyweight);
    let light = profile("independent-light", Worker);
    let frontier = profile("too-high", Frontier);
    let pool = [
        candidate(&worker),
        candidate(&shares_model),
        candidate(&independent),
        candidate(&light),
        candidate(&frontier),
    ];
    for (critical, selected) in [(true, &independent), (false, &light)] {
        let mut task = working(&format!(
            "---\nqueue: {{complexity: very_high, critical: {critical}}}\n---\nInvestigate."
        ));
        finish_worker(&mut task, &worker);
        let available = pick(&task, &open('a'), UsageLevel::High, &pool);
        assert_eq!(available.profile(), selected);
        assert_eq!(available.critical_fallback_worker(), None);
        let fallback_pool = [
            candidate(&worker),
            candidate(&shares_model),
            candidate(&light),
            candidate(&frontier),
        ];
        let fallback = pick(&task, &open('a'), ExtraHigh, &fallback_pool);
        assert_eq!(fallback.profile(), &light);
        assert_eq!(
            fallback.critical_fallback_worker(),
            critical.then_some(worker.id.as_str())
        );
    }
}

#[test]
fn a_critical_fallback_reviewer_continues_until_the_ordinary_bracket_changes() {
    let mut task =
        working("---\nqueue: {complexity: very_high, critical: true}\n---\nInvestigate.");
    let worker = profile("author", Heavyweight);
    let fallback = profile("fallback", Worker);
    let peer = profile("peer", Heavyweight);
    finish_worker(&mut task, &worker);
    review_changes(&mut task, &open('a'), &fallback);

    let obs = role_thread(open('a'), "reviewer-1", RetainedThread::Idle);
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    task.command(Command::Move(Phase::Reviewing), &planner, &obs)
        .unwrap();

    let pool = [candidate(&fallback), candidate(&peer)];
    let same = pick(&task, &obs, UsageLevel::High, &pool);
    assert_eq!(same.profile(), &fallback);
    assert_eq!(same.critical_fallback_worker(), None);
    assert_eq!(
        same.via(),
        &Launch::Continue {
            thread: "reviewer-1".into()
        }
    );

    let raised = pick(&task, &obs, ExtraHigh, &pool);
    assert_eq!(raised.profile(), &peer);
    assert_eq!(raised.via(), &Launch::Create);
    assert_eq!(raised.replaced_thread(), Some("reviewer-1"));
}

#[test]
fn configured_heavyweight_profiles_supply_work_and_independent_review() {
    let stored = serde_json::json!([
        {"name":"Sol heavyweight","roles":["reviewer"],"scopes":["mechanical"],
         "selection":{"id":"sol","provider":"codex","model":"gpt-6.2-sol","capability":"heavyweight"}},
        {"name":"Sonnet heavyweight","roles":["worker"],"scopes":["complex"],
         "selection":{"id":"sonnet","provider":"claude","model":"claude-sonnet-5","capability":"heavyweight"}},
        {"name":"Astra frontier","roles":["worker"],
         "selection":{"id":"astra","provider":"codex","model":"gpt-6.2-astra","capability":"frontier"}}
    ]);
    let selections: Vec<Profile> = stored
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| serde_json::from_value(entry["selection"].clone()).unwrap())
        .collect();
    let [sol, sonnet, astra] = selections.as_slice() else {
        panic!("expected three configured profiles");
    };
    let brief = "---\nqueue: {complexity: very_high}\n---\nImplement.";
    let mut task = working(brief);
    assert_eq!(
        pick(&task, &unbound(), Normal, &[candidate(sol)]).profile(),
        sol
    );
    finish_worker(&mut task, sol);
    assert_eq!(
        pick(
            &task,
            &open('a'),
            Normal,
            &[candidate(sol), candidate(sonnet), candidate(astra)],
        )
        .profile(),
        sonnet
    );

    let frontier = [candidate(astra)];
    let requested = working(
        "---\nqueue: {complexity: very_high, profileRequests: {worker: {profileId: astra, reason: investigation}}}\n---\nImplement.",
    );
    for usage in [UsageLevel::Low, Normal, UsageLevel::High] {
        assert!(matches!(
            select(&working(brief), &unbound(), usage, &frontier),
            Err(ProfileLaunchError::NoEligibleProfile { .. })
        ));
        assert_eq!(
            pick(&requested, &unbound(), usage, &frontier).profile(),
            astra
        );
    }
}

#[test]
fn reviewer_frontier_request_preserves_independence_and_role_bounds() {
    let worker = profile("frontier", Frontier);
    let mut same_model = profile("same-model", Frontier);
    same_model.model.clone_from(&worker.model);
    let peer = profile("peer", Frontier);
    let fallback = profile("fallback", Heavyweight);
    for (requested, selected) in [("peer", &peer), ("same-model", &fallback)] {
        let mut task = working(&format!(
            "---\nqueue: {{complexity: very_high, profileRequests: {{worker: {{profileId: frontier, reason: investigation}}, reviewer: {{profileId: {requested}, reason: independent}}}}}}\n---\nInvestigate.",
        ));
        finish_worker(&mut task, &worker);
        for usage in [UsageLevel::Low, Normal, UsageLevel::High] {
            let pool = [
                candidate(&worker),
                candidate(&same_model),
                candidate(&peer),
                candidate(&fallback),
            ];
            assert_eq!(pick(&task, &open('a'), usage, &pool).profile(), selected);
        }
    }
}

#[test]
fn review_entry_excludes_declared_and_opaque_author_models() {
    let entry = task("Review this pull request.", Entry::ReviewEntry);
    let author = profile("author", Mechanical);
    let reviewer = profile("reviewer", Mechanical);
    let pool = [candidate(&author), candidate(&reviewer)];
    let mut policy = LaunchPolicy {
        usage: Normal,
        candidates: &pool,
        planner_brief: true,
        author_models: &["vendor/MODEL-AUTHOR"],
    };
    let selection = decide_profile_launch(&entry, &open('a'), &policy)
        .unwrap()
        .unwrap();
    assert_eq!(selection.profile(), &reviewer);
    policy.author_models = &["vendor/unknown"];
    assert!(matches!(
        decide_profile_launch(&entry, &open('a'), &policy),
        Err(ProfileLaunchError::OpaqueAuthor)
    ));
}

#[test]
fn capability_and_availability_filter_before_rotation() {
    let task = working("---\nqueue: {complexity: medium}\n---\nAdd facts.");
    let exact = profile("exact", Heavyweight);
    let next = profile("next", Frontier);
    let best_shortfall = profile("best-shortfall", Worker);
    let low = profile("low", Mechanical);
    let others = [
        candidate(&next),
        candidate(&best_shortfall),
        candidate(&low),
    ];
    let pool = [candidate(&exact), others[0], others[1], others[2]];
    assert_eq!(pick(&task, &unbound(), Maximum, &pool).profile(), &exact);
    assert_eq!(pick(&task, &unbound(), Maximum, &others).profile(), &next);
    assert_eq!(
        pick(&task, &unbound(), Maximum, &others[1..]).profile(),
        &best_shortfall
    );
    assert_eq!(
        pick(
            &task,
            &unbound(),
            Normal,
            &[candidate(&exact), candidate(&low)]
        )
        .profile(),
        &low
    );

    let disabled = Candidate {
        enabled: false,
        ..candidate(&exact)
    };
    let unavailable = Candidate {
        available: false,
        ..candidate(&exact)
    };
    let exhausted = Candidate {
        group_available: false,
        ..candidate(&exact)
    };
    for other in [disabled, unavailable, exhausted] {
        assert_eq!(
            pick(&task, &unbound(), Maximum, &[other, candidate(&low)]).profile(),
            &low
        );
    }
}

#[test]
fn all_weight_stops_affect_rotation_and_do_not_gate_eligibility() {
    let task = working("Rotate profiles.");
    let mut a = profile("a", Worker);
    let b = profile("b", Worker);
    let weights = [
        Weight::Fewest,
        Weight::Fewer,
        Weight::Default,
        Weight::More,
        Weight::Most,
    ];
    assert_eq!(weights.map(Weight::share), [50, 75, 100, 150, 200]);
    assert_eq!(
        weights.map(|weight| serde_json::to_value(weight).unwrap()),
        ["fewest", "fewer", "default", "more", "most"]
    );
    for (weight, expected) in weights.into_iter().zip([53, 69, 80, 96, 107]) {
        a.weight = weight;
        assert_eq!(
            pick(&task, &unbound(), Normal, &[candidate(&a)]).profile(),
            &a
        );
        let mut recent = VecDeque::new();
        let mut in_window = [0, 0];
        let mut lifetime = [0, 0];
        for _ in 0..160 {
            let pool = [&a, &b].map(candidate);
            let pool = pool
                .into_iter()
                .zip(in_window)
                .zip(lifetime)
                .map(|((mut candidate, profile_recent), profile_lifetime)| {
                    candidate.counts.profile_recent = profile_recent;
                    candidate.counts.profile_lifetime = profile_lifetime;
                    candidate
                })
                .collect::<Vec<_>>();
            let selected = pick(&task, &unbound(), Normal, &pool);
            let index = usize::from(selected.profile() == &b);
            in_window[index] += 1;
            lifetime[index] += 1;
            recent.push_back(index);
            if recent.len() > 50 {
                in_window[recent.pop_front().unwrap()] -= 1;
            }
        }
        assert!(
            lifetime[0].abs_diff(expected) <= 3,
            "{weight:?}: {lifetime:?}"
        );
    }
}

#[test]
fn rotation_ties_use_group_then_lifetime_then_stable_id() {
    let task = working("Rotate profiles.");
    let a = profile("a", Worker);
    let b = profile("b", Worker);
    let mut first = candidate(&a);
    let mut second = candidate(&b);
    let cases = [
        (
            RotationCounts {
                profile_recent: 1,
                ..RotationCounts::default()
            },
            RotationCounts::default(),
            &b,
        ),
        (
            RotationCounts {
                group_recent: 1,
                ..RotationCounts::default()
            },
            RotationCounts {
                profile_lifetime: 2,
                ..RotationCounts::default()
            },
            &b,
        ),
        (
            RotationCounts {
                profile_lifetime: 1,
                ..RotationCounts::default()
            },
            RotationCounts {
                group_lifetime: 2,
                ..RotationCounts::default()
            },
            &b,
        ),
        (
            RotationCounts {
                group_lifetime: 1,
                ..RotationCounts::default()
            },
            RotationCounts::default(),
            &b,
        ),
        (RotationCounts::default(), RotationCounts::default(), &a),
    ];
    for (counts_a, counts_b, expected) in cases {
        first.counts = counts_a;
        second.counts = counts_b;
        assert_eq!(
            pick(&task, &unbound(), Normal, &[second, first]).profile(),
            expected
        );
    }
}

#[test]
fn an_instructed_worker_continuation_keeps_its_profile_over_a_new_request() {
    let retained = profile("retained", Mechanical);
    let other = profile("other", Worker);
    let mut task = working(
        "---\nqueue:\n  profileRequests:\n    worker: {profileId: other, reason: Try this model}\n---\nFix the issue.",
    );
    finish_worker(&mut task, &retained);
    let observation = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    task.command(
        Command::MoveWork {
            instruction: "Rebase the task branch".into(),
        },
        &Authority::Operator {
            actor: "operator".into(),
        },
        &observation,
    )
    .unwrap();
    let pool = [candidate(&retained), candidate(&other)];
    let next = pick(&task, &observation, Normal, &pool);
    assert_eq!(
        next.via(),
        &Launch::Continue {
            thread: "worker-1".into()
        }
    );
    assert_eq!(next.profile(), &retained);
    let pool = [candidate(&other)];
    let policy = LaunchPolicy {
        usage: Normal,
        candidates: &pool,
        planner_brief: true,
        author_models: &[],
    };
    assert!(matches!(
        decide_profile_launch(&task, &observation, &policy),
        Err(ProfileLaunchError::RequiredProfileUnavailable { role: Role::Worker, id }) if id == "retained"
    ));
}

#[test]
fn a_paused_instructed_revision_reselects_unless_the_brief_requires_its_profile() {
    let retained = profile("retained", Mechanical);
    let alternative = profile("alternative", Worker);
    let reviewer = profile("reviewer", Mechanical);
    let pool = [
        Candidate {
            group_available: false,
            ..candidate(&retained)
        },
        candidate(&reviewer),
        candidate(&alternative),
    ];
    let observation = role_thread(open('a'), "worker-1", RetainedThread::Idle);
    for required in [false, true] {
        let brief = if required {
            "---\nqueue: {complexity: low, profileRequests: {worker: {profileId: retained, reason: fixture, required: true}}}\n---\nFix the issue."
        } else {
            "---\nqueue: {complexity: low}\n---\nFix the issue."
        };
        let mut task = working(brief);
        finish_worker(&mut task, &retained);
        review_changes(&mut task, &open('a'), &reviewer);
        task.command(
            Command::MoveWork {
                instruction: "Rebase the task branch".into(),
            },
            &Authority::Planner {
                actor: "fixture-planner".into(),
            },
            &observation,
        )
        .unwrap();

        let result = select(&task, &observation, Normal, &pool);
        if required {
            assert!(matches!(
                result,
                Err(ProfileLaunchError::RequiredProfileUnavailable { role: Role::Worker, id })
                    if id == retained.id
            ));
        } else {
            let replacement = result.unwrap().unwrap();
            assert_eq!(replacement.profile(), &alternative);
            assert_eq!(replacement.via(), &Launch::Create);
            assert_eq!(replacement.replaced_thread(), Some("worker-1"));
            assert_eq!(replacement.step_up_from(), Some(Mechanical));
            assert_eq!(
                replacement.findings(),
                Some("Fix the race in the revision path.")
            );
        }
    }
}

#[test]
fn completion_notices_are_on_unless_the_brief_opts_out() {
    let notifies = |brief: &str| {
        BriefPolicy::parse(brief)
            .unwrap()
            .notifies_origin_on_closeout()
    };
    assert!(notifies(
        "---\nqueue:\n  complexity: low\n---\n# Fix rounding"
    ));
    assert!(notifies("Plain brief."));
    assert!(notifies(
        "---\nqueue:\n  notifyOriginOnCloseout: true\n---\n# Fix rounding"
    ));
    assert!(!notifies(
        "---\nqueue:\n  notifyOriginOnCloseout: false\n---\n# Fix rounding"
    ));
    assert!(BriefPolicy::parse("---\nqueue:\n  notifyOriginOnCloseout: maybe\n---\nBody").is_err());
}
