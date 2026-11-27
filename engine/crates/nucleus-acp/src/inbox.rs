use std::{
    collections::{BTreeMap, btree_map::Entry},
    sync::Arc,
    time::Duration,
};

use nucleus_core::acp::{INBOX_PREVIEW_TIMEOUT, InboxAnswer, InboxForm};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, mpsc},
    time::{Instant, sleep_until},
};

use crate::{
    Output, Turn,
    client::{Failure, ServiceClient},
    error, notify,
    presentation::message,
    stop,
};

const REQUEST_PREFIX: &str = "nucleus-inbox:";

pub(crate) fn response_session(frame: &Value) -> Option<&str> {
    let request = frame["id"].as_str()?.strip_prefix(REQUEST_PREFIX)?;
    let (session, _) = request.split_once(':')?;
    Some(session)
}

// A turn can queue one answer per form it actually offered. Keeping the
// eligibility check at input also keeps stdin available for cancellation.
pub(crate) struct Replies {
    cards: Mutex<BTreeMap<String, Card>>,
    answers: mpsc::UnboundedSender<(String, InboxAnswer)>,
}

impl Replies {
    pub(crate) fn channel() -> (Self, mpsc::UnboundedReceiver<(String, InboxAnswer)>) {
        let (answers, receive) = mpsc::unbounded_channel();
        (
            Self {
                cards: Mutex::default(),
                answers,
            },
            receive,
        )
    }

    pub(crate) async fn receive(&self, frame: &Value) {
        let mut cards = self.cards.lock().await;
        if let Some(answer) = take_answer(&mut cards, frame) {
            let request = cards[&answer.field].request.clone();
            let _ = self.answers.send((request, answer));
        }
    }
}

pub(crate) fn prompt(
    client: ServiceClient,
    output: &Output,
    session: &str,
    id: &Value,
    wait_for_ui_reply: bool,
) -> Turn {
    let (replies, receive) = Replies::channel();
    let replies = Arc::new(replies);
    let turn_replies = Arc::clone(&replies);
    let output = output.clone();
    let session = session.to_owned();
    let request = id.clone();
    let job = tokio::spawn(async move {
        // ACP text is only a hint to wait for a reply. The scheduler proves
        // that T3 actually recorded a direct operator message.
        // The scheduler can finish an in-flight automatic open before serving
        // this message. Allow both attempts and the next service refresh.
        let until = wait_for_ui_reply
            .then(|| Instant::now() + 2 * INBOX_PREVIEW_TIMEOUT + Duration::from_secs(5));
        match follow(&client, &output, &session, &turn_replies, receive, until).await {
            Ok(()) => stop(&output, &request, "end_turn"),
            Err(failure) => error(&output, &request, -32000, &failure.to_string()),
        }
    });
    Turn {
        id: id.clone(),
        job,
        replies: Some(replies),
    }
}

pub(crate) async fn follow(
    client: &ServiceClient,
    output: &Output,
    session: &str,
    replies: &Replies,
    mut answers: mpsc::UnboundedReceiver<(String, InboxAnswer)>,
    mut wait_for_ui: Option<Instant>,
) -> Result<(), Failure> {
    // Carry requests across reconnects. An ambiguous HTTP response never repeats an answer.
    let mut delay = 1;
    loop {
        let result = async {
            let mut changes = client.stream().await?;
            loop {
                let deadline = wait_for_ui;
                tokio::select! {
                    change = changes.next() => {
                        change?;
                        if !refresh_cards(client, output, session, &replies.cards, &mut wait_for_ui).await? {
                            return Ok(());
                        }
                        delay = 1;
                    }
                    Some((request, answer)) = answers.recv() => {
                        let current = replies.cards.lock().await.get(&answer.field).is_some_and(|card| card.request == request);
                        if current
                            && let Err(failure) = client.answer(&answer).await
                        {
                            notify(output, session, message(&failure.to_string()));
                            // The client settled this request. Read back the ordinary
                            // decision before offering a fresh form.
                            replies.cards.lock().await.remove(&answer.field);
                            if !refresh_cards(client, output, session, &replies.cards, &mut wait_for_ui).await? {
                                return Ok(());
                            }
                        }
                    }
                    () = async {
                        if let Some(deadline) = deadline {
                            sleep_until(deadline).await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        wait_for_ui = None;
                        if !refresh_cards(client, output, session, &replies.cards, &mut wait_for_ui).await? {
                            return Ok(());
                        }
                    }
                }
            }
        }
        .await;
        match result {
            Err(Failure::Unavailable | Failure::Engine(_)) => {
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(30);
            }
            result => return result,
        }
    }
}

async fn refresh_cards(
    client: &ServiceClient,
    output: &Output,
    session: &str,
    cards: &Mutex<BTreeMap<String, Card>>,
    wait_for_ui: &mut Option<Instant>,
) -> Result<bool, Failure> {
    let snapshot = client.inbox().await?;
    if snapshot.replies_ready {
        let replies = client
            .take_inbox_replies(snapshot.reply_run.as_deref())
            .await?;
        if !replies.is_empty() {
            *wait_for_ui = None;
        }
        for reply in replies {
            notify(output, session, message(&reply));
        }
    }
    let has_pending = !snapshot.pending.is_empty();
    let mut cards = cards.lock().await;
    cards.retain(|field, _| snapshot.pending.iter().any(|form| &form.field == field));
    for form in snapshot.pending.into_iter().filter(|form| form.offer) {
        if let Entry::Vacant(slot) = cards.entry(form.field.clone()) {
            slot.insert(elicit(output, session, &form)?);
        }
    }
    Ok(has_pending || wait_for_ui.is_some())
}

struct Card {
    request: String,
    options: Vec<String>,
    settled: bool,
}

fn take_answer(cards: &mut BTreeMap<String, Card>, response: &Value) -> Option<InboxAnswer> {
    let request = response["id"].as_str()?;
    let (field, card) = cards
        .iter_mut()
        .find(|(_, card)| card.request == request && !card.settled)?;
    card.settled = true;
    let result = &response["result"];
    let answer = result["content"][field.as_str()].as_str()?;
    (result["action"] == "accept" && card.options.iter().any(|option| option == answer)).then(
        || InboxAnswer {
            field: field.clone(),
            option_id: answer.to_owned(),
        },
    )
}

fn elicit(output: &Output, session: &str, form: &InboxForm) -> Result<Card, Failure> {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| Failure::Binding)?;
    let request = format!("{REQUEST_PREFIX}{session}:{}", hex::encode(nonce));
    let options: Vec<_> = form
        .choices
        .iter()
        .map(|choice| {
            json!({
                "const": choice.id, "title": choice.label,
            })
        })
        .collect();
    let _ = output.send(json!({
        "jsonrpc": "2.0",
        "id": request,
        "method": "elicitation/create",
        "params": {
            "sessionId": session,
            "mode": "form",
            "message": form.question,
            "requestedSchema": {
                "type": "object",
                "required": [form.field],
                "properties": {
                    (&form.field): { "type": "string", "title": form.question, "oneOf": options }
                }
            }
        }
    }));
    Ok(Card {
        request,
        options: form
            .choices
            .iter()
            .map(|choice| choice.id.clone())
            .collect(),
        settled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::acp::InboxChoice;

    #[tokio::test]
    async fn a_burst_queues_one_answer_per_offered_form_while_the_consumer_is_busy() {
        let (output, mut offers) = mpsc::unbounded_channel();
        let (answers, mut queued) = mpsc::unbounded_channel();
        let replies = Replies {
            cards: Mutex::default(),
            answers,
        };
        for i in 0..65 {
            let field = format!("field{i}");
            let form = InboxForm {
                field: field.clone(),
                question: "Continue?".into(),
                choices: vec![InboxChoice {
                    id: "yes".into(),
                    label: "Yes".into(),
                }],
                offer: true,
            };
            let card = elicit(&output, "fixture", &form).unwrap();
            replies.cards.lock().await.insert(field.clone(), card);
            let offer = offers.try_recv().unwrap();
            let response = json!({"jsonrpc":"2.0","id":offer["id"], "result":{"action":"accept","content":{field:"yes"}}});
            replies.receive(&response).await;
            replies.receive(&response).await;
        }
        for i in 0..65 {
            let (_, answer) = queued.try_recv().unwrap();
            assert_eq!(answer.field, format!("field{i}"));
            assert_eq!(answer.option_id, "yes");
        }
        assert!(queued.try_recv().is_err());
    }
}
