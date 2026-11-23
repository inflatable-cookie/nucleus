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

fn server(responses: Vec<Option<Value>>) -> (GitHub, JoinHandle<Vec<Request>>) {
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
                let json = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}", json.len()).expect("write fixture response");
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
        None,
        Some(pull('a', true)),
        Some(pull('a', true)),
    ]);
    let target = branches().target(PR_URL).expect("target");
    let task = task_with_approval();
    for _ in 0..2 {
        let merged = forge.merge(&task, &target).await.expect("read back merge");
        assert!(
            matches!(merged, Forge::Merged { pr, commit } if pr.head == sha('a') && commit == sha('f'))
        );
    }
    let requests = calls.join().expect("HTTP requests");
    let [read, graph, merge, readback, replay] = requests.as_slice() else {
        panic!("five requests")
    };
    assert!(read.method_and_path.starts_with(&format!("GET {PR_PATH} ")));
    assert!(graph.method_and_path.starts_with("POST /graphql "));
    assert!(
        merge
            .method_and_path
            .starts_with(&format!("PUT {PR_PATH}/merge "))
    );
    assert_eq!(
        merge.body,
        Some(json!({"sha": sha('a'), "merge_method": "squash"}))
    );
    for read in [readback, replay] {
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
        let observed = forge
            .merge(
                &task_with_approval(),
                &branches().target(PR_URL).expect("target"),
            )
            .await
            .expect("observe without merging");
        assert!(
            matches!(observed, Forge::Open { pr, checks } if pr.head == sha(digit) && checks == expected)
        );
        assert_eq!(calls.join().expect("HTTP requests").len(), 2);
    }
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
