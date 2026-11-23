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
        "state": if merged { "closed" } else { "open" },
        "merge_commit_sha": if merged { Some(sha('f')) } else { None },
        "head": {"ref": "ns-task-1", "sha": sha(head), "repo": {"full_name": "example/fixture"}},
        "base": {"ref": "main", "sha": sha('b'), "repo": {"full_name": "example/fixture"}}
    })
}

fn checks(head: char, state: &str) -> Value {
    json!({"data": {"repository": {"pullRequest": {
        "headRefOid": sha(head), "baseRefName": "main", "isDraft": false,
        "state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
        "reviewDecision": null, "statusCheckRollup": {"state": state},
        "reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": false}}
    }}}})
}

struct Request {
    method_and_path: String,
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
            let mut length = 0;
            loop {
                let mut header = String::new();
                assert_ne!(reader.read_line(&mut header).expect("read request header"), 0);
                if header == "\r\n" { break; }
                if let Some((name, value)) = header.split_once(':')
                    && name.eq_ignore_ascii_case("Content-Length") {
                    length = value.trim().parse().expect("valid fixture content length");
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).expect("read body");
            if let Some(response) = response {
                let json = response.body.to_string();
                write!(stream, "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{json}", response.status, json.len(), response.headers).expect("write fixture response");
            }
            Request { method_and_path, body: (!body.is_empty()).then(|| serde_json::from_slice(&body).expect("fixture JSON")) }
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
    assert!(matches!(error, ForgeError::Decode { .. }));
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
