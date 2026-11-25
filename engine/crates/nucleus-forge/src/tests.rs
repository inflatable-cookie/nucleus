use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    thread::{self, JoinHandle},
    time::Duration,
};

use nucleus_core::{
    CheckState, Entry, Head, Host, Identity, LaunchInputs, Phase, PullRequest, Report, Review,
    RunState, Workspace,
};
use serde_json::Value;

use super::*;

const PR_URL: &str = "https://github.com/example/fixture/pull/7";
const PR_PATH: &str = "/repos/example/fixture/pulls/7";

fn sha(digit: char) -> Head {
    digit.to_string().repeat(40).parse().expect("fixture SHA")
}

fn branches() -> Branches {
    Branches::new("example/fixture", "main", "ns-task-1").expect("valid fixture branches")
}

fn task_with_approval() -> Task {
    let pr = PullRequest {
        url: PR_URL.into(),
        head: sha('a'),
    };
    let mut task = Task::new(
        Identity {
            id: "task-1".into(),
            reference: "fixture#7".into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry: Entry::ReviewEntry,
            origin_thread: None,
        },
        "Review the greeting".into(),
        Some(pr.clone()),
    );
    let obs = Observation {
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(sha('a'))),
    };
    let credential = task
        .reserve_launch(
            &obs,
            LaunchInputs {
                scratch: None,
                thread: "reviewer".into(),
                started_at: 1,
                input: "review".into(),
            },
            &[7; 32],
        )
        .expect("launch reviewer");
    let instance = task.run().expect("run").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Review {
            head: sha('a'),
            decision: Review::Approve,
            summary: "Reviewed".into(),
            finding_titles: Vec::new(),
        },
    )
    .expect("record approval");
    assert_eq!(
        task.reconcile(&Observation {
            host: Observed::Known(Host::Current {
                instance,
                state: RunState::Ended
            }),
            ..obs
        }),
        Action::Advance(Phase::Merging)
    );
    task
}

fn pull(head: char, merged: bool) -> Value {
    json!({
        "number": 7, "html_url": PR_URL, "merged": merged,
        "user": {"id": 11, "login": "fixture-author"},
        "state": if merged { "closed" } else { "open" },
        "merge_commit_sha": if merged { Some(sha('f')) } else { None },
        "head": {"ref": "ns-task-1", "sha": sha(head), "repo": {"full_name": "example/fixture"}},
        "base": {"ref": "main", "sha": sha('b'), "repo": {"full_name": "example/fixture"}}
    })
}

fn checks(head: char, state: &str) -> Value {
    json!({"data": {"repository": {"pullRequest": {
        "headRefOid": sha(head), "baseRefName": "main", "baseRefOid": sha('b'), "isDraft": false,
        "state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
        "reviewDecision": null, "statusCheckRollup": {"state": state, "contexts": {"pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": []}},
        "reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": false, "endCursor": null}}
    }}}})
}

fn merged_without_commit() -> Value {
    let mut merged = pull('a', true);
    merged["merge_commit_sha"] = Value::Null;
    merged
}

fn merged_graph(head: char, base: &str, state: &str, commit: Option<Head>) -> Value {
    json!({"data": {"repository": {"pullRequest": {
        "headRefOid": sha(head), "baseRefName": base, "state": state,
        "mergeCommit": commit.map(|oid| json!({"oid": oid}))
    }}}})
}

struct Request {
    at: std::time::Instant,
    validator: Option<String>,
    method_and_path: String,
    authorization: String,
    body: Option<Value>,
}

struct FixtureReply {
    status: u16,
    headers: &'static str,
    body: Value,
}

impl FixtureReply {
    fn ok(body: Value) -> Self {
        Self {
            status: 200,
            headers: "",
            body,
        }
    }
}

fn server(responses: Vec<Option<Value>>) -> (GitHub, JoinHandle<Vec<Request>>) {
    scripted(
        responses
            .into_iter()
            .map(|value| value.map(FixtureReply::ok))
            .collect(),
    )
}

fn scripted(responses: Vec<Option<FixtureReply>>) -> (GitHub, JoinHandle<Vec<Request>>) {
    let socket = TcpListener::bind("127.0.0.1:0").expect("bind HTTP fixture");
    let addr = socket.local_addr().expect("fixture address");
    let thread = thread::spawn(move || {
        responses.into_iter().map(|response| {
            let (mut stream, _) = socket.accept().expect("accept fixture request");
            stream.set_read_timeout(Some(Duration::from_secs(3))).expect("read timeout");
            let mut reader = BufReader::new(&stream);
            let mut method_and_path = String::new();
            reader.read_line(&mut method_and_path).expect("read request line");
            let at = std::time::Instant::now();
            let mut validator = None;
            let mut length = 0;
            let mut authorization = String::new();
            loop {
                let mut header = String::new();
                assert_ne!(reader.read_line(&mut header).expect("read request header"), 0);
                if header == "\r\n" { break; }
                if let Some((name, value)) = header.split_once(':')
 {
                    if name.eq_ignore_ascii_case("Content-Length") {
                        length = value.trim().parse().expect("valid fixture content length");
                    }
                    if name.eq_ignore_ascii_case("If-None-Match") { validator = Some(value.trim().into()); }
                    if name.eq_ignore_ascii_case("Authorization") {
                        authorization = value.trim().into();
                    }
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).expect("read body");
            if let Some(response) = response {
                let json = response.body.to_string();
                write!(stream, "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{json}", response.status, json.len(), response.headers).expect("write fixture response");
            }
            Request { at, validator, method_and_path, authorization, body: (!body.is_empty()).then(|| serde_json::from_slice(&body).expect("fixture JSON")) }
        }).collect()
    });
    let github = GitHub::with_origin("synthetic-token", format!("http://{addr}"))
        .expect("HTTP fixture client");
    (github, thread)
}

#[tokio::test]
async fn a_lost_merge_reply_reconciles_the_same_pr_without_resubmission() {
    let (forge, calls) = server(vec![
        Some(pull('a', false)),
        Some(checks('a', "SUCCESS")),
        Some(pull('a', false)),
        None,
        Some(pull('a', true)),
        Some(pull('a', true)),
    ]);
    let target = branches().target(PR_URL).expect("target");
    let task = task_with_approval();
    for write in [MergeWrite::Unknown, MergeWrite::Skipped] {
        let attempt = forge.merge(&task, &target).await.expect("read back merge");
        assert_eq!(attempt.write, write);
        assert!(
            matches!(attempt.observed, Ok(Forge::Merged { pr, commit }) if pr.head == sha('a') && commit == sha('f'))
        );
    }
    let requests = calls.join().expect("HTTP requests");
    let [read, graph, preflight, merge, readback, replay] = requests.as_slice() else {
        panic!("six requests")
    };
    assert!(read.method_and_path.starts_with(&format!("GET {PR_PATH} ")));
    assert!(graph.method_and_path.starts_with("POST /graphql "));
    let query = graph.body.as_ref().expect("GraphQL body")["query"]
        .as_str()
        .expect("GraphQL query");
    let tokens =
        query.split(|character: char| !character.is_ascii_alphanumeric() && character != '_');
    for field in ["reviewDecision", "statusCheckRollup"] {
        assert!(
            tokens.clone().any(|token| token == field),
            "separate GraphQL field {field}"
        );
    }
    assert!(
        merge
            .method_and_path
            .starts_with(&format!("PUT {PR_PATH}/merge "))
    );
    assert_eq!(
        merge.body,
        Some(json!({"sha": sha('a'), "merge_method": "squash"}))
    );
    for read in [preflight, readback, replay] {
        assert!(read.method_and_path.starts_with(&format!("GET {PR_PATH} ")));
    }
}

#[tokio::test]
async fn a_missing_rest_merge_commit_uses_the_exact_graphql_merge() {
    let graph = merged_graph('a', "main", "MERGED", Some(sha('f')));
    let (forge, calls) = server(vec![
        Some(pull('a', false)),
        Some(checks('a', "SUCCESS")),
        Some(pull('a', false)),
        None,
        Some(merged_without_commit()),
        Some(graph.clone()),
        Some(merged_without_commit()),
        Some(graph),
    ]);
    let target = branches().target(PR_URL).expect("target");
    let task = task_with_approval();
    for write in [MergeWrite::Unknown, MergeWrite::Skipped] {
        let attempt = forge.merge(&task, &target).await.expect("confirm merge");
        assert_eq!(attempt.write, write);
        assert!(matches!(
            attempt.observed, Ok(Forge::Merged { pr, commit }) if pr.head == sha('a') && commit == sha('f')
        ));
    }
    let requests = calls.join().expect("HTTP trace");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method_and_path.starts_with("PUT "))
            .count(),
        1
    );
    for index in [5, 7] {
        let request = &requests[index];
        assert!(request.method_and_path.starts_with("POST /graphql "));
        let body = request.body.as_ref().expect("GraphQL body");
        assert_eq!(
            body["variables"],
            json!({"owner":"example","repo":"fixture","number":7})
        );
        assert!(
            body["query"]
                .as_str()
                .expect("query")
                .contains("mergeCommit{oid}")
        );
    }
}

#[tokio::test]
async fn graphql_must_confirm_the_merged_head_base_and_commit() {
    let target = branches().target(PR_URL).expect("target");
    for (head, base, state, commit) in [
        ('b', "main", "MERGED", Some(sha('f'))),
        ('a', "other", "MERGED", Some(sha('f'))),
        ('a', "main", "OPEN", Some(sha('f'))),
        ('a', "main", "MERGED", None),
    ] {
        let (forge, calls) = server(vec![
            Some(merged_without_commit()),
            Some(merged_graph(head, base, state, commit)),
        ]);
        let error = forge
            .observe(&target)
            .await
            .expect_err("merge proof is incomplete");
        assert!(matches!(
            error,
            ForgeError::Incomplete | ForgeError::BaseChanged
        ));
        assert_eq!(calls.join().expect("proof reads").len(), 2);
    }
}

#[tokio::test]
async fn a_new_head_or_unfinished_checks_do_not_send_a_merge() {
    for (digit, rollup, expected) in [
        ('b', "SUCCESS", CheckState::Ready),
        ('a', "PENDING", CheckState::Pending),
    ] {
        let (forge, calls) = server(vec![Some(pull(digit, false)), Some(checks(digit, rollup))]);
        let attempt = forge
            .merge(
                &task_with_approval(),
                &branches().target(PR_URL).expect("target"),
            )
            .await
            .expect("observe without merging");
        assert_eq!(attempt.write, MergeWrite::Skipped);
        assert!(
            matches!(attempt.observed, Ok(Forge::Open { pr, checks }) if pr.head == sha(digit) && checks == expected)
        );
        assert_eq!(calls.join().expect("HTTP requests").len(), 2);
    }
}

fn ready_preflight() -> Vec<Option<FixtureReply>> {
    [pull('a', false), checks('a', "SUCCESS"), pull('a', false)]
        .into_iter()
        .map(|value| Some(FixtureReply::ok(value)))
        .collect()
}

#[tokio::test]
async fn write_outcomes_survive_stale_or_unreadable_readback() {
    let target = branches().target(PR_URL).expect("target");
    for (status, expected) in [
        (409, MergeWrite::HeadMismatch),
        (
            405,
            MergeWrite::Refused {
                status: StatusCode::METHOD_NOT_ALLOWED,
            },
        ),
        (502, MergeWrite::Unknown),
    ] {
        let mut responses = ready_preflight();
        responses.push(Some(FixtureReply {
            status,
            headers: "",
            body: json!({}),
        }));
        if status == 405 {
            responses.push(None);
        } else {
            responses.extend([
                Some(FixtureReply::ok(pull('a', false))),
                Some(FixtureReply::ok(checks('a', "SUCCESS"))),
            ]);
        }
        let (forge, calls) = scripted(responses);
        let attempt = forge
            .merge(&task_with_approval(), &target)
            .await
            .expect("keep write outcome");
        assert_eq!(attempt.write, expected);
        match status {
            409 => assert!(matches!(
                attempt.observed,
                Err(ForgeError::HeadNotRefreshed)
            )),
            405 => assert!(attempt.observed.is_err()),
            _ => assert!(matches!(
                attempt.observed,
                Ok(Forge::Open {
                    checks: CheckState::Ready,
                    ..
                })
            )),
        }
        calls.join().expect("HTTP requests");
    }
}

#[tokio::test]
async fn an_unresolved_optional_conversation_does_not_override_github_merge_state() {
    let target = branches().target(PR_URL).expect("target");
    let mut graphql = checks('a', "SUCCESS");
    graphql["data"]["repository"]["pullRequest"]["reviewThreads"] = json!({
        "nodes": [{"isResolved": false}], "pageInfo": {"hasNextPage": true},
    });
    let (forge, calls) = server(vec![Some(pull('a', false)), Some(graphql)]);
    assert!(matches!(
        forge.observe(&target).await,
        Ok(Forge::Open {
            checks: CheckState::Ready,
            ..
        })
    ));
    let calls = calls.join().expect("HTTP requests");
    let query = calls[1].body.as_ref().expect("GraphQL body")["query"]
        .as_str()
        .expect("GraphQL query");
    assert!(!query.contains("reviewThreads"));
}

#[tokio::test]
async fn a_rate_limited_put_returns_the_deadline_without_readback() {
    let target = branches().target(PR_URL).expect("target");
    let reset = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
    for (status, headers) in [
        (429, "Retry-After: 75\r\n"),
        (
            403,
            "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 2000000000\r\n",
        ),
    ] {
        let before = SystemTime::now();
        let mut responses = ready_preflight();
        responses.push(Some(FixtureReply {
            status,
            headers,
            body: json!({}),
        }));
        let (forge, calls) = scripted(responses);
        let attempt = forge
            .merge(&task_with_approval(), &target)
            .await
            .expect("deferral");
        let MergeWrite::Deferred { until } = attempt.write else {
            panic!("expected retry deadline")
        };
        if status == 429 {
            assert!(until >= before + Duration::from_secs(75));
        } else {
            assert_eq!(until, reset);
        }
        assert!(
            matches!(attempt.observed, Err(ForgeError::Deferred { until: read_until }) if read_until == until)
        );
        assert_eq!(calls.join().expect("HTTP requests").len(), 4);
    }
}

#[tokio::test]
async fn a_secondary_limit_body_defers_even_when_primary_requests_remain() {
    let target = branches().target(PR_URL).expect("target");
    let reset = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
    for (headers, expected) in [
        ("X-RateLimit-Remaining: 100\r\n", None),
        (
            "X-RateLimit-Remaining: 100\r\nX-RateLimit-Reset: 2000000000\r\n",
            Some(reset),
        ),
    ] {
        let before = SystemTime::now();
        let mut responses = ready_preflight();
        responses.push(Some(FixtureReply {
            status: 403,
            headers,
            body: json!({"message": "You have exceeded a secondary rate limit."}),
        }));
        let (forge, calls) = scripted(responses);
        let attempt = forge
            .merge(&task_with_approval(), &target)
            .await
            .expect("secondary deferral");
        let MergeWrite::Deferred { until } = attempt.write else {
            panic!("expected retry deadline")
        };
        assert!(until >= before + Duration::from_mins(1));
        if let Some(expected) = expected {
            assert_eq!(until, expected);
        }
        assert_eq!(calls.join().expect("no readback").len(), 4);
    }
}

#[tokio::test]
async fn a_graphql_rate_error_uses_the_reset_before_interpreting_partial_data() {
    let target = branches().target(PR_URL).expect("target");
    for headers in [
        "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 2000000000\r\n",
        "X-RateLimit-Reset: 2000000000\r\n",
    ] {
        let (forge, calls) = scripted(vec![
            Some(FixtureReply::ok(pull('a', false))),
            Some(FixtureReply {
                status: 200,
                headers,
                body: json!({"data": {"repository": false}, "errors": [{"type": "RATE_LIMITED"}]}),
            }),
        ]);
        assert!(matches!(forge.merge(&task_with_approval(), &target).await,
            Err(ForgeError::Deferred { until }) if until == UNIX_EPOCH + Duration::from_secs(2_000_000_000)));
        assert_eq!(calls.join().expect("no further calls").len(), 2);
    }
}

#[tokio::test]
async fn a_graphql_problem_names_the_failed_read_without_copying_the_body() {
    let target = branches().target(PR_URL).expect("target");
    let (forge, calls) = server(vec![
        Some(pull('a', false)),
        Some(json!({"errors":[{"message":"synthetic-value", "type":"INVALID_QUERY"}]})),
    ]);
    let error = forge.observe(&target).await.expect_err("query rejected");
    assert!(matches!(error, ForgeError::GraphQlRejected));
    assert!(!format!("{error:?} {error}").contains("synthetic-value"));
    assert_eq!(calls.join().expect("exact requests").len(), 2);
}

#[tokio::test]
async fn decoder_errors_do_not_reveal_diagnostic_values() {
    const TOKEN: &str = "synthetic-token-in-response";
    let target = branches().target(PR_URL).expect("target");
    let mut body = pull('a', false);
    body["state"] = json!(TOKEN);
    let (forge, calls) = server(vec![Some(body)]);
    let error = forge.observe(&target).await.expect_err("invalid state");
    assert!(matches!(error, ForgeError::Incomplete));
    assert!(!format!("{error:?}").contains(TOKEN));
    assert!(!error.to_string().contains(TOKEN));
    calls.join().expect("HTTP requests");
}

#[tokio::test]
async fn a_retargeted_base_is_checked_before_and_after_the_put() {
    let target = branches().target(PR_URL).expect("target");
    let mut retargeted = pull('a', false);
    retargeted["base"]["ref"] = json!("another-base");
    let (forge, calls) = server(vec![
        Some(pull('a', false)),
        Some(checks('a', "SUCCESS")),
        Some(retargeted),
    ]);
    assert!(matches!(
        forge.merge(&task_with_approval(), &target).await,
        Err(ForgeError::BaseChanged)
    ));
    assert_eq!(calls.join().expect("HTTP requests").len(), 3);

    let mut after = pull('a', true);
    after["base"]["ref"] = json!("another-base");
    let mut responses = ready_preflight();
    responses.extend([
        Some(FixtureReply::ok(json!({"merged": true, "sha": sha('f')}))),
        Some(FixtureReply::ok(after)),
    ]);
    let (forge, calls) = scripted(responses);
    let attempt = forge
        .merge(&task_with_approval(), &target)
        .await
        .expect("write and readback");
    assert_eq!(attempt.write, MergeWrite::Merged { commit: sha('f') });
    assert!(matches!(attempt.observed, Err(ForgeError::BaseChanged)));
    assert_eq!(calls.join().expect("HTTP requests").len(), 5);
}

#[tokio::test]
async fn a_foreign_head_repository_or_disagreeing_check_head_is_unknown() {
    let mut fork = pull('a', false);
    fork["head"]["repo"]["full_name"] = json!("foreign/fixture");
    let target = branches().target(PR_URL).expect("target");
    let (forge, calls) = server(vec![Some(fork)]);
    assert!(matches!(
        forge.observe(&target).await,
        Err(ForgeError::Identity)
    ));
    calls.join().expect("HTTP requests");

    let (forge, calls) = server(vec![Some(pull('a', false)), Some(checks('b', "SUCCESS"))]);
    assert!(matches!(
        forge.observe(&target).await,
        Err(ForgeError::Incomplete)
    ));
    calls.join().expect("HTTP requests");
}

#[test]
fn a_pull_target_stays_inside_the_configured_repository() {
    for url in [
        "https://github.com/example/other/pull/7",
        "https://elsewhere.example/example/fixture/pull/7",
        "https://github.com/example/fixture/pull/7/files",
        "https://github.com/example/fixture/pull/0",
        "https://user@github.com/example/fixture/pull/7",
    ] {
        assert!(
            matches!(branches().target(url), Err(ForgeError::Identity)),
            "{url}"
        );
    }
}

#[tokio::test]
async fn a_selected_check_rollup_must_be_present_even_when_null() {
    let target = branches().target(PR_URL).unwrap();
    for present in [false, true] {
        let mut response = checks('a', "SUCCESS");
        let pr = response["data"]["repository"]["pullRequest"]
            .as_object_mut()
            .unwrap();
        if present {
            pr.insert("statusCheckRollup".into(), Value::Null);
        } else {
            pr.remove("statusCheckRollup");
        }
        let (forge, server) = server(vec![Some(pull('a', false)), Some(response)]);
        let result = forge.observe(&target).await;
        if present {
            assert!(matches!(
                result,
                Ok(Forge::Open {
                    checks: CheckState::Ready,
                    ..
                })
            ));
        } else {
            assert!(matches!(result, Err(ForgeError::Incomplete)));
        }
        assert_eq!(server.join().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn named_project_checks_need_passing_github_branch_rules_at_the_head() {
    for (required, expected) in [(true, CheckState::Ready), (false, CheckState::Unreported)] {
        let mut response = checks('a', "SUCCESS");
        response["data"]["repository"]["pullRequest"]["statusCheckRollup"]["contexts"] = json!({
            "pageInfo": {"hasNextPage": false, "endCursor": null},
            "nodes": [{"__typename": "CheckRun", "name": "CI", "conclusion": "SUCCESS", "isRequired": required}],
        });
        let (forge, calls) = server(vec![Some(pull('a', false)), Some(response)]);
        let target = branches()
            .target(PR_URL)
            .expect("target")
            .with_required_checks(vec!["CI".into()]);
        assert!(
            matches!(forge.observe(&target).await, Ok(Forge::Open { checks, .. }) if checks == expected)
        );
        let requests = calls.join().expect("HTTP requests");
        assert_eq!(
            requests[1].body.as_ref().expect("GraphQL request")["variables"]["namedChecks"],
            true
        );
    }
}

#[tokio::test]
async fn classifies_only_positive_rebase_or_required_failure_evidence() {
    let ci = |conclusion: Option<&str>, required| json!({"__typename":"CheckRun","name":"Build / release","conclusion":conclusion,"isRequired":required});
    let lint =
        json!({"__typename":"StatusContext","context":"Lint","state":"FAILURE","isRequired":true});
    let failed = CheckState::FailedRequired(vec!["Build / release".into(), "Lint".into()]);
    for (mergeable, state, rollup, nodes, incomplete, expected) in [
        (
            "CONFLICTING",
            "DIRTY",
            "FAILURE",
            json!([]),
            false,
            CheckState::Conflict,
        ),
        (
            "MERGEABLE",
            "BEHIND",
            "PENDING",
            json!([]),
            false,
            CheckState::BaseMoved,
        ),
        (
            "MERGEABLE",
            "BLOCKED",
            "FAILURE",
            json!([ci(Some("FAILURE"), true), lint]),
            false,
            failed,
        ),
        (
            "MERGEABLE",
            "BLOCKED",
            "FAILURE",
            json!([ci(Some("FAILURE"), false)]),
            false,
            CheckState::Blocked,
        ),
        (
            "MERGEABLE",
            "BLOCKED",
            "PENDING",
            json!([ci(None, true)]),
            false,
            CheckState::Pending,
        ),
        (
            "MERGEABLE",
            "CLEAN",
            "SUCCESS",
            json!([ci(Some("SUCCESS"), true)]),
            true,
            CheckState::Unknown,
        ),
        (
            "MERGEABLE",
            "CLEAN",
            "SUCCESS",
            Value::Null,
            false,
            CheckState::Unknown,
        ),
    ] {
        let mut response = checks('a', rollup);
        let wire = &mut response["data"]["repository"]["pullRequest"];
        wire["mergeable"] = json!(mergeable);
        wire["mergeStateStatus"] = json!(state);
        wire["statusCheckRollup"]["contexts"] = if nodes.is_null() {
            nodes
        } else {
            json!({"pageInfo":{"hasNextPage":incomplete,"endCursor":null},"nodes":nodes})
        };
        let (forge, server) = server(vec![Some(pull('a', false)), Some(response)]);
        assert!(
            matches!(
                forge.observe_for_merge(&branches().target(PR_URL).unwrap()).await,
                Ok(Forge::Open { checks, .. }) if checks == expected
            ),
            "{mergeable}, {state}, {rollup}: {expected:?}"
        );
        let requests = server.join().expect("forge reads");
        assert_eq!(
            requests[1].body.as_ref().unwrap()["variables"]["namedChecks"],
            true
        );
    }
}

fn check_page(head: char, base: char, cursor: Option<&str>, nodes: &Value) -> Value {
    let mut reply = checks(head, "SUCCESS");
    let pr = &mut reply["data"]["repository"]["pullRequest"];
    pr["baseRefOid"] = json!(sha(base));
    pr["statusCheckRollup"]["contexts"] = json!({
        "pageInfo": { "hasNextPage": cursor.is_some(), "endCursor": cursor }, "nodes": nodes,
    });
    reply
}

#[tokio::test]
async fn merge_checks_read_the_required_context_on_the_second_page() {
    let first: Vec<_> = (0..100)
        .map(|i| {
            json!({"__typename": "StatusContext", "context": format!("optional-{i}"),
        "state": "SUCCESS", "isRequired": false})
        })
        .collect();
    let second = json!([{"__typename": "CheckRun", "name": "ci", "conclusion": "SUCCESS", "isRequired": true}]);
    let (forge, calls) = server(vec![
        Some(pull('a', false)),
        Some(check_page('a', 'b', Some("page-two"), &json!(first))),
        Some(check_page('a', 'b', None, &second)),
        Some(pull('a', false)),
        Some(json!({"merged": true, "sha": sha('f')})),
        Some(pull('a', true)),
    ]);
    let mut branches = branches();
    branches.required_checks = vec!["ci".into()];
    let result = forge
        .merge(&task_with_approval(), &branches.target(PR_URL).unwrap())
        .await
        .expect("merge");
    assert!(matches!(result.observed, Ok(Forge::Merged { .. })));
    let calls = calls.join().unwrap();
    assert_eq!(
        calls[2].body.as_ref().unwrap()["variables"]["after"],
        "page-two"
    );
    assert!(calls[4].method_and_path.starts_with("PUT "));
    assert_eq!(calls[4].body.as_ref().unwrap()["sha"], json!(sha('a')));
}

#[tokio::test]
async fn single_check_page_requires_the_observed_base_commit() {
    for oid in [None, Some(sha('d'))] {
        let mut reply = checks('a', "SUCCESS");
        let page = reply["data"]["repository"]["pullRequest"]
            .as_object_mut()
            .unwrap();
        if let Some(oid) = oid {
            page.insert("baseRefOid".into(), json!(oid));
        } else {
            page.remove("baseRefOid");
        }
        let (forge, calls) = server(vec![Some(pull('a', false)), Some(reply)]);
        let result = forge
            .observe_for_merge(&branches().target(PR_URL).unwrap())
            .await;
        assert!(matches!(result, Err(ForgeError::Incomplete)));
        assert_eq!(calls.join().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn a_changed_head_base_or_repeated_cursor_cannot_clear_merge_preflight() {
    for (head, base, next) in [
        ('c', 'b', None),
        ('a', 'd', None),
        ('a', 'b', Some("again")),
    ] {
        let (forge, calls) = server(vec![
            Some(pull('a', false)),
            Some(check_page('a', 'b', Some("again"), &json!([]))),
            Some(check_page(head, base, next, &json!([]))),
        ]);
        let result = forge
            .observe_for_merge(&branches().target(PR_URL).unwrap())
            .await;
        assert!(matches!(
            result,
            Err(ForgeError::Incomplete)
                | Ok(Forge::Open {
                    checks: CheckState::Unknown,
                    ..
                })
        ));
        assert_eq!(calls.join().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn a_successful_partial_inventory_stays_unknown_at_either_paging_bound() {
    let success = json!([{"__typename": "CheckRun", "name": "ci", "conclusion": "SUCCESS", "isRequired": true}]);
    for repeat in [false, true] {
        let count = if repeat { 2 } else { 10 };
        let mut replies = vec![Some(pull('a', false))];
        for page in 0..count {
            let cursor = if repeat {
                "same".into()
            } else {
                page.to_string()
            };
            replies.push(Some(check_page('a', 'b', Some(&cursor), &success)));
        }
        let (forge, calls) = server(replies);
        let mut branches = branches();
        branches.required_checks = vec!["ci".into()];
        let observed = forge
            .observe_for_merge(&branches.target(PR_URL).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            observed,
            Forge::Open {
                checks: CheckState::Unknown,
                ..
            }
        ));
        assert_eq!(calls.join().unwrap().len(), count + 1);
    }
}

#[tokio::test]
async fn a_missing_review_decision_stops_before_another_page_or_merge_put() {
    let task = task_with_approval();
    let target = branches().target(PR_URL).unwrap();
    for paged in [false, true] {
        let cursor = paged.then_some("next");
        let mut first = check_page('a', 'b', cursor, &json!([]));
        first["data"]["repository"]["pullRequest"]
            .as_object_mut()
            .unwrap()
            .remove("reviewDecision");
        let mut pages = vec![Some(pull('a', false)), Some(first)];
        if paged {
            pages.push(Some(check_page('a', 'b', None, &json!([]))));
        }
        let (forge, calls) = server(pages);
        assert!(matches!(
            forge.merge(&task, &target).await,
            Err(ForgeError::Incomplete)
        ));
        if paged {
            // Independently read the available second page. Its explicit null is valid.
            let second = forge
                .query_pull(&target, CHECKS_QUERY, true, cursor)
                .await
                .unwrap();
            assert!(second.checks(&sha('a'), "main", &sha('b'), true).is_ok());
        }
        let requests = calls.join().unwrap();
        assert_eq!(requests.len(), if paged { 3 } else { 2 });
        assert!(
            requests
                .iter()
                .all(|request| !request.method_and_path.starts_with("PUT "))
        );
    }
}

#[tokio::test]
async fn a_base_sha_change_during_preflight_skips_the_merge_write() {
    let task = task_with_approval();
    let mut moved = pull('a', false);
    moved["base"]["sha"] = json!(sha('d'));
    let (forge, server) = server(vec![
        Some(pull('a', false)),
        Some(checks('a', "SUCCESS")),
        Some(moved),
    ]);
    let attempt = forge
        .merge(&task, &branches().target(PR_URL).unwrap())
        .await
        .expect("merge preflight");
    assert_eq!(attempt.write, MergeWrite::Skipped);
    assert!(matches!(
        attempt.observed,
        Ok(Forge::Open {
            checks: CheckState::BaseMoved,
            ..
        })
    ));
    assert_eq!(server.join().expect("GET and GraphQL only").len(), 3);
}

#[tokio::test]
async fn a_refused_put_uses_positive_same_head_rebase_evidence_from_readback() {
    for (status, head, base, conflicting, expected) in [
        (405, 'a', 'd', false, CheckState::BaseMoved),
        (405, 'a', 'b', false, CheckState::Ready),
        (409, 'a', 'b', true, CheckState::Conflict),
        (409, 'c', 'd', false, CheckState::Ready),
        (502, 'a', 'd', false, CheckState::Ready),
    ] {
        let mut responses = ready_preflight();
        let mut fresh_pull = pull(head, false);
        fresh_pull["base"]["sha"] = json!(sha(base));
        let mut fresh_checks = checks(head, "SUCCESS");
        fresh_checks["data"]["repository"]["pullRequest"]["baseRefOid"] = json!(sha(base));
        if conflicting {
            let pr = &mut fresh_checks["data"]["repository"]["pullRequest"];
            pr["mergeable"] = json!("CONFLICTING");
            pr["mergeStateStatus"] = json!("DIRTY");
        }
        responses.extend([
            Some(FixtureReply {
                status,
                headers: "",
                body: json!({}),
            }),
            Some(FixtureReply::ok(fresh_pull)),
            Some(FixtureReply::ok(fresh_checks)),
        ]);
        let total = responses.len();
        let (forge, calls) = scripted(responses);
        let target = branches().target(PR_URL).unwrap();
        let attempt = forge.merge(&task_with_approval(), &target).await.unwrap();
        assert!(
            matches!(attempt.observed, Ok(Forge::Open { pr, checks })
            if pr.head == sha(head) && checks == expected),
            "HTTP {status} with readback head {head} and base {base}"
        );
        assert_eq!(
            calls.join().expect("the ordinary readback only").len(),
            total
        );
    }
}

fn formal_review(id: u64, user: u64, head: char, state: &str, body: &str) -> Value {
    json!({
        "id": id, "user": {"id": user, "login": "reviewer"},
        "commit_id": sha(head), "state": state, "body": body,
    })
}

#[tokio::test]
async fn a_review_inventory_with_a_missing_body_is_incomplete() {
    let head = sha('a');
    let binding = ReviewBinding {
        pull_author: 11.try_into().unwrap(),
        author: 42.try_into().unwrap(),
        head: &head,
        decision: Review::Changes,
    };
    let mut review = formal_review(7, 42, 'a', "CHANGES_REQUESTED", "text");
    review.as_object_mut().unwrap().remove("body");
    let (forge, calls) = server(vec![Some(json!([review]))]);
    let result = forge
        .find_review(
            &branches().target(PR_URL).unwrap(),
            &binding,
            "marker",
            "text",
        )
        .await;
    assert!(matches!(
        result,
        Err(ReviewError::Forge(ForgeError::Incomplete))
    ));
    assert_eq!(calls.join().unwrap().len(), 1);
}

#[tokio::test]
async fn reviewer_posts_once_and_operator_reconciles_the_lost_response() {
    let marker = "<!-- nucleus-review:test -->";
    let body = format!("Changes needed\n\n{marker}");
    let review = formal_review(7, 42, 'a', "CHANGES_REQUESTED", &body);
    let (operator, thread) = server(vec![
        Some(json!({"id": 11, "login": "operator"})),
        Some(json!({"id": 42, "login": "reviewer"})),
        Some(pull('a', false)),
        None,
        Some(json!([review.clone()])),
        Some(review),
    ]);
    let target = branches().target(PR_URL).expect("fixture target");
    let reviewer = operator
        .with_review_bearer("reviewer-fixture", 42.try_into().unwrap())
        .await
        .unwrap();
    let user = reviewer.authenticated_user().await.unwrap();
    let binding = ReviewBinding {
        pull_author: 11.try_into().unwrap(),
        author: user.id,
        head: &sha('a'),
        decision: Review::Changes,
    };
    operator
        .review_preflight(&target, binding.head, binding.author, binding.decision)
        .await
        .unwrap();
    assert!(matches!(
        reviewer.submit_review(&target, &binding, &body).await,
        ReviewWrite::Unknown(_)
    ));
    let recovered = operator
        .find_review(&target, &binding, marker, &body)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.id.get(), 7);
    let verified = operator
        .read_review(&target, &binding, recovered.id)
        .await
        .unwrap();
    assert_eq!(verified.body, body);
    let requests = thread.join().unwrap();
    assert_eq!(requests[0].authorization, "Bearer synthetic-token");
    let requests = &requests[1..];
    assert_eq!(requests[0].authorization, "Bearer reviewer-fixture");
    assert_eq!(requests[1].authorization, "Bearer synthetic-token");
    assert_eq!(requests[2].authorization, "Bearer reviewer-fixture");
    assert_eq!(requests[3].authorization, "Bearer synthetic-token");
    assert_eq!(requests[4].authorization, "Bearer synthetic-token");
    assert_eq!(
        requests[2].body,
        Some(json!({"commit_id": sha('a'), "event": "REQUEST_CHANGES", "body": body}))
    );
    assert!(requests[2].method_and_path.starts_with("POST "));
    assert!(requests[3].method_and_path.starts_with("GET "));
    assert!(requests[4].method_and_path.starts_with("GET "));
}

#[tokio::test]
async fn approval_refuses_the_pull_author_and_a_moved_head_before_the_post() {
    let mut same_author = pull('a', false);
    same_author["user"] = json!({"id": 42, "login": "renamed"});
    let (operator, thread) = server(vec![Some(same_author), Some(pull('b', false))]);
    let target = branches().target(PR_URL).expect("fixture target");
    let binding = ReviewBinding {
        pull_author: 11.try_into().unwrap(),
        author: 42.try_into().unwrap(),
        head: &sha('a'),
        decision: Review::Approve,
    };
    assert!(matches!(
        operator
            .review_preflight(&target, binding.head, binding.author, binding.decision)
            .await,
        Err(ReviewError::SameAuthor)
    ));
    assert!(matches!(
        operator
            .review_preflight(&target, binding.head, binding.author, binding.decision)
            .await,
        Err(ReviewError::StaleHead)
    ));
    assert!(
        thread
            .join()
            .unwrap()
            .iter()
            .all(|request| request.method_and_path.starts_with("GET "))
    );
}

#[tokio::test]
async fn readback_rejects_wrong_id_author_head_or_verdict() {
    let body = "findings";
    let (operator, thread) = server(vec![
        Some(formal_review(8, 42, 'a', "APPROVED", body)),
        Some(formal_review(7, 99, 'a', "APPROVED", body)),
        Some(formal_review(7, 42, 'b', "APPROVED", body)),
        Some(formal_review(7, 42, 'a', "DISMISSED", body)),
    ]);
    let target = branches().target(PR_URL).expect("fixture target");
    let binding = ReviewBinding {
        pull_author: 11.try_into().unwrap(),
        author: 42.try_into().unwrap(),
        head: &sha('a'),
        decision: Review::Approve,
    };
    for _ in 0..4 {
        assert!(matches!(
            operator
                .read_review(&target, &binding, 7.try_into().unwrap())
                .await,
            Err(ReviewError::Mismatched)
        ));
    }
    thread.join().unwrap();
}

#[tokio::test]
async fn ancestry_proofs_follow_the_current_pull_ref_and_branch_tip() {
    let target = branches().target(PR_URL).unwrap();
    let reference =
        |head| json!({"ref":"refs/pull/7/head","object":{"type":"commit","sha":sha(head)}});
    let branch = |head| json!({"name":"main","commit":{"sha":sha(head)}});
    let (forge, calls) = server(vec![
        Some(reference('b')),
        Some(json!({"status":"ahead"})),
        Some(reference('b')),
        Some(reference('c')),
        Some(reference('c')),
        Some(json!({"status":"diverged"})),
        Some(branch('b')),
        Some(branch('c')),
        Some(json!({"status":"behind"})),
    ]);
    for (head, expected) in [('b', true), ('b', true), ('b', false), ('c', false)] {
        assert_eq!(
            forge
                .pull_descends_from(&target, &sha('a'), &sha(head))
                .await
                .unwrap(),
            expected
        );
    }
    forge.verify_merge_base(&target, &sha('a')).await.unwrap();
    assert!(matches!(
        forge.verify_merge_base(&target, &sha('a')).await,
        Err(ForgeError::UnpublishedMerge)
    ));
    let calls = calls.join().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.method_and_path.contains("/compare/"))
            .count(),
        3
    );
}

#[tokio::test]
async fn account_deadlines_and_write_spacing_follow_identity_across_bearers() {
    let same = 42.try_into().unwrap();
    let other = 11.try_into().unwrap();
    let user = json!({"id": 42, "login": "operator"});
    let (operator, calls) = scripted(vec![
        Some(FixtureReply::ok(user.clone())),
        Some(FixtureReply::ok(json!({}))),
        Some(FixtureReply::ok(json!({}))),
        Some(FixtureReply {
            status: 403,
            headers: "Retry-After: 1\r\n",
            body: json!({"message":"secondary rate limit"}),
        }),
        Some(FixtureReply::ok(json!({"id":11, "login":"reviewer"}))),
    ]);
    let reviewer = operator
        .with_review_bearer("refreshed-bearer", same)
        .await
        .unwrap();
    let distinct = operator
        .with_review_bearer("different-bearer", other)
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        operator.write(operator.client.put(format!("{}/merge", operator.origin))),
        reviewer.write(reviewer.client.post(format!("{}/reviews", reviewer.origin))),
    );
    first.unwrap();
    second.unwrap();
    let before = SystemTime::now();
    let Err(ForgeError::Deferred { until }) = reviewer.authenticated_user().await else {
        panic!("secondary throttle")
    };
    assert!(until >= before + Duration::from_mins(1));
    let refreshed = operator
        .with_review_bearer("replacement-bearer", same)
        .await
        .unwrap();
    for handle in [&operator, &refreshed] {
        assert!(
            matches!(handle.authenticated_user().await, Err(ForgeError::Deferred { until: held }) if held == until)
        );
    }
    assert_eq!(distinct.authenticated_user().await.unwrap().id, other);
    let calls = calls.join().unwrap();
    assert!(calls[2].at.duration_since(calls[1].at) >= Duration::from_secs(1));
}

#[tokio::test]
async fn conditional_reads_revalidate_each_credential_and_page() {
    let ok = || {
        Some(FixtureReply {
            status: 200,
            headers: "ETag: W/\"first\"\r\n",
            body: json!(7),
        })
    };
    let (client, calls) = scripted(vec![
        ok(),
        Some(FixtureReply {
            status: 304,
            headers: "",
            body: Value::Null,
        }),
        ok(),
        Some(FixtureReply::ok(json!({"id":42,"login":"operator"}))),
        ok(),
        Some(FixtureReply::ok(json!(8))),
        Some(FixtureReply::ok(json!(9))),
    ]);
    let page = format!("{}/reviews?page=1", client.origin);
    for _ in 0..2 {
        assert_eq!(client.get::<u64>(&page).await.unwrap(), 7);
    }
    client
        .get::<u64>(format!("{}/reviews?page=2", client.origin))
        .await
        .unwrap();
    let other = client
        .with_review_bearer("scoped-bearer", 42.try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(other.get::<u64>(&page).await.unwrap(), 7);
    assert_eq!(client.get::<u64>(&page).await.unwrap(), 8);
    assert_eq!(client.get::<u64>(&page).await.unwrap(), 9);
    let calls = calls.join().unwrap();
    let validators: Vec<_> = calls.iter().map(|r| r.validator.as_deref()).collect();
    assert_eq!(
        validators,
        [
            None,
            Some("W/\"first\""),
            None,
            None,
            None,
            Some("W/\"first\""),
            None
        ]
    );
}

#[tokio::test]
async fn a_second_read_waits_until_the_first_body_finishes() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = GitHub::with_origin(
        "fixture",
        format!("http://{}", socket.local_addr().unwrap()),
    )
    .unwrap();
    let server = thread::spawn(move || {
        let (mut first, _) = socket.accept().unwrap();
        let mut request = [0; 4096];
        assert!(first.read(&mut request).unwrap() > 0);
        first
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n1")
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        socket.set_nonblocking(true).unwrap();
        assert_eq!(
            socket.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        first.write_all(b"2").unwrap();
        socket.set_nonblocking(false).unwrap();
        let (mut second, _) = socket.accept().unwrap();
        assert!(second.read(&mut request).unwrap() > 0);
        second
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n34")
            .unwrap();
    });
    let (one, two) = tokio::join!(
        client.get::<u64>(&client.origin),
        client.get::<u64>(&client.origin)
    );
    assert_eq!((one.unwrap(), two.unwrap()), (12, 34));
    server.join().unwrap();
}
