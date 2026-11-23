use std::{cmp::Reverse, path::Path};

use nucleus_core::{Action, Question, Task, WaitReason};
use nucleus_hosts::{HostError, NoticeState, T3};
use nucleus_store::{TaskRow, ThreadProvenance};

use crate::{RegisteredRole, Service, ServiceError, event, project::linked_checkout};

impl Service {
    pub(super) async fn notify_question(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let wait = Action::Wait(WaitReason::Question);
        let bound = if let Some(delivery) = row.task.question_delivery() {
            match self.host.notice_state(delivery).await? {
                NoticeState::Started => return Ok(wait),
                NoticeState::Gone => None,
                NoticeState::Absent | NoticeState::Queued => Some(delivery),
            }
        } else {
            None
        };
        let mut attempt = if let Some(delivery) = bound {
            delivery.clone()
        } else {
            let Some(thread) = self.responsible_planner(&row.task).await? else {
                return Ok(wait);
            };
            let question = row.task.question().ok_or(ServiceError::Input)?;
            let command = format!("task-{}-question-{}", row.task.identity().id, row.version);
            T3::prepare_notice(thread, command, &notice_text(&row.task, question))?
        };
        let Some(authorization) = self.host.authorize_notice(&attempt).await? else {
            return Ok(wait);
        };
        let _fence = self.effect(row).await?;
        authorization.record(&mut attempt)?;
        let mut updated = row.task.clone();
        if !updated.bind_question_delivery(attempt.clone()) {
            return Err(ServiceError::Input);
        }
        self.save(row, updated, &event("question_delivery")).await?;
        self.host.send_notice(&attempt, authorization).await?;
        Ok(wait)
    }

    async fn responsible_planner(&self, task: &Task) -> Result<Option<String>, ServiceError> {
        if let Some(origin) = &task.identity().origin_thread
            && self.routable(origin).await?
        {
            return Ok(Some(origin.clone()));
        }
        // Titles carry no authority. Registered roles and task provenance set
        // rank, with project membership as the last candidate source.
        let threads = self.host.planner_threads().await?;
        let ids: Vec<_> = threads.iter().map(|thread| thread.id.as_str()).collect();
        let provenance = self
            .state
            .lock()
            .await
            .store
            .routing_provenance(&self.project.repository, &ids)?;
        let mut candidates: Vec<_> = threads
            .into_iter()
            .filter_map(|thread| {
                if thread.archived_at.is_some()
                    || thread.deleted_at.is_some()
                    || provenance.get(&thread.id) == Some(&ThreadProvenance::TaskRole)
                {
                    return None;
                }
                let registered = self
                    .project
                    .agents
                    .iter()
                    .filter(|agent| agent.thread == thread.id)
                    .map(|agent| match agent.role {
                        RegisteredRole::Planner => 0,
                        RegisteredRole::Agent => 1,
                    })
                    .min();
                let rank = registered
                    .or_else(|| {
                        (provenance.get(&thread.id) == Some(&ThreadProvenance::Dispatcher))
                            .then_some(2)
                    })
                    .or_else(|| (thread.project_id == self.project.host_project).then_some(3))?;
                let interaction = match thread.latest_user_message_at {
                    Some(last) => last.max(thread.updated_at),
                    None => thread.updated_at,
                };
                Some((rank, Reverse(interaction), thread.id, thread.worktree_path))
            })
            .collect();
        candidates.sort_unstable();
        for (rank, _, id, worktree) in candidates {
            if rank == 3
                && let Some(worktree) = worktree
            {
                let project = self.project.checkout.clone();
                let matching = tokio::task::spawn_blocking(move || {
                    linked_checkout(&project, Path::new(&worktree))
                })
                .await
                .map_err(|_| HostError::Uncertain)??;
                if !matching {
                    continue;
                }
            }
            if self.routable(&id).await? {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    async fn routable(&self, id: &str) -> Result<bool, ServiceError> {
        match self.host.planner_routable(id).await {
            Ok(available) => Ok(available),
            Err(HostError::Binding) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

fn notice_text(task: &Task, question: &Question) -> String {
    let request = match question {
        Question::Work { prompt, options } if !options.is_empty() => {
            format!("{prompt}\n\nOptions\n- {}", options.join("\n- "))
        }
        Question::Work { prompt, .. } => prompt.clone(),
        Question::Retry { role } => {
            format!("The {role:?} stopped three times. Decide whether to retry.")
        }
        Question::Accept { head } => format!(
            "The PR was merged externally. Decide whether to accept closeout at commit {head}."
        ),
        Question::Repair(repair) => {
            format!("The task needs a decision about the PR or checkout ({repair:?}).")
        }
    };
    format!(
        "Task {} needs input.\n\n{request}\n\nAnswer through Nucleus.",
        task.identity().reference
    )
}

#[cfg(test)]
mod tests {
    use axum::{
        Json, Router,
        extract::ws::{Message, WebSocketUpgrade},
        routing::{get, post},
    };
    use nucleus_core::{Entry, Identity};
    use nucleus_forge::GitHub;
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn exact_origin_wins_and_fallback_respects_rank_and_unknown() {
        for (origin, strongest, expected) in [
            ("origin", "planner-old", Some("origin")),
            ("gone", "planner-old", Some("planner-old")),
            ("gone", "unverified", None),
            ("gone", "mismatch", Some("planner-other")),
        ] {
            let (_home, mut service) =
                crate::tests::fixture(GitHub::new("unused-test-forge").expect("forge"));
            let (host, server) = native_fixture(strongest).await;
            service.host = host;
            service.project.agents = [
                (strongest, RegisteredRole::Planner),
                ("planner-other", RegisteredRole::Planner),
                ("registered-agent", RegisteredRole::Agent),
            ]
            .into_iter()
            .map(|(thread, role)| crate::RegisteredAgent {
                thread: thread.into(),
                role,
            })
            .collect();
            let task = Task::new(
                Identity {
                    id: "notice".into(),
                    reference: "fixture".into(),
                    repository: service.project.repository.clone(),
                    base: service.project.base.clone(),
                    entry: Entry::Brief,
                    origin_thread: Some(origin.into()),
                },
                "fixture brief".into(),
                None,
            );
            let result = service.responsible_planner(&task).await;
            if let Some(expected) = expected {
                assert_eq!(result.expect("exact routing").as_deref(), Some(expected));
            } else {
                assert!(matches!(
                    result,
                    Err(ServiceError::Host(HostError::Uncertain))
                ));
            }
            server.abort();
        }
    }

    async fn native_fixture(strongest: &'static str) -> (T3, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route("/api/auth/websocket-ticket/rpc", post(|| async { Json(json!({"ticket":"fixture"})) }))
            .route("/ws", get(move |upgrade: WebSocketUpgrade| async move {
                upgrade.on_upgrade(move |mut ws| async move {
                    while let Some(Ok(Message::Text(frame))) = ws.recv().await {
                        let req: Value = serde_json::from_str(&frame).expect("Effect request");
                        if req["_tag"] != "Request" {
                            continue;
                        }
                        let mut projection = match req["tag"].as_str() {
                            Some("orchestration.subscribeShell") => json!({"snapshot": {"threads": [
                                shell(strongest, "2026-11-02T00:00:00.000Z"),
                                shell("planner-other", "2026-11-01T00:00:00.000Z"),
                                shell("registered-agent", "2026-11-03T00:00:00.000Z")
                            ]}}),
                            Some("orchestration.subscribeThread") => {
                                let id = req["payload"]["threadId"].as_str().expect("exact thread");
                                json!({"hasMoreHistory": id == "unverified", "projection": {"thread": {
                                    "id": if id == "mismatch" { "another-thread" } else { id },
                                    "archivedAt": (id == "gone").then_some("2026-11-01T00:00:00.000Z")
                                }}})
                            }
                            _ => panic!("unexpected method"),
                        };
                        projection["kind"] = json!("snapshot");
                        let reply = json!({
                            "_tag": "Chunk", "requestId": req["id"],
                            "values": [projection, {"kind":"synchronized"}],
                        });
                        ws.send(Message::Text(reply.to_string().into())).await.expect("reply");
                    }
                })
            }));
        let tcp = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let host = T3::new(
            &format!("http://{}", tcp.local_addr().expect("address")),
            "fixture",
        )
        .expect("native client");
        (
            host,
            tokio::spawn(async {
                axum::serve(tcp, app).await.expect("native server");
            }),
        )
    }

    fn shell(id: &str, time: &str) -> Value {
        json!({"id": id, "projectId": "local-fixture", "updatedAt": time})
    }
}
