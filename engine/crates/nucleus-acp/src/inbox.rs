use std::{
    collections::{BTreeMap, btree_map::Entry},
    time::Duration,
};

use nucleus_core::acp::{InboxAnswer, InboxForm};
use serde_json::{Value, json};
use tokio::sync::mpsc;

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

pub(crate) fn prompt(client: ServiceClient, output: &Output, session: &str, id: &Value) -> Turn {
    let (send, receive) = mpsc::channel(64);
    let output = output.clone();
    let session = session.to_owned();
    let request = id.clone();
    let job = tokio::spawn(async move {
        match follow(&client, &output, &session, receive).await {
            Ok(()) => stop(&output, &request, "end_turn"),
            Err(failure) => error(&output, &request, -32000, &failure.to_string()),
        }
    });
    Turn {
        id: id.clone(),
        job,
        replies: Some(send),
    }
}

async fn follow(
    client: &ServiceClient,
    output: &Output,
    session: &str,
    mut replies: mpsc::Receiver<Value>,
) -> Result<(), Failure> {
    // Carry requests across reconnects. An ambiguous HTTP response never repeats an answer.
    let mut cards = BTreeMap::<String, Card>::new();
    let mut delay = 1;
    loop {
        let result = async {
            let mut changes = client.stream().await?;
            loop {
                tokio::select! {
                    change = changes.next() => {
                        change?;
                        if !refresh_cards(client, output, session, &mut cards).await? {
                            return Ok(());
                        }
                        delay = 1;
                    }
                    Some(response) = replies.recv() => {
                        if let Some(answer) = take_answer(&mut cards, &response)
                            && let Err(failure) = client.answer(&answer).await
                        {
                            notify(output, session, message(&failure.to_string()));
                            // The client settled this request. Read back the ordinary
                            // decision before offering a fresh form.
                            cards.remove(&answer.field);
                            if !refresh_cards(client, output, session, &mut cards).await? {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
        .await;
        match result {
            Err(Failure::Unavailable) => {
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
    cards: &mut BTreeMap<String, Card>,
) -> Result<bool, Failure> {
    let snapshot = client.inbox().await?;
    let has_pending = !snapshot.pending.is_empty();
    cards.retain(|field, _| snapshot.pending.iter().any(|form| &form.field == field));
    for form in snapshot.pending.into_iter().filter(|form| form.offer) {
        if let Entry::Vacant(slot) = cards.entry(form.field.clone()) {
            slot.insert(elicit(output, session, &form)?);
        }
    }
    Ok(has_pending)
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
