//! The task session's native projection of a planner work question.

use nucleus_core::{Answer, Command, Question};
use serde_json::{Map, Value, json};

use crate::{
    Output,
    client::{Detail, Failure},
    inbox::request_form,
};

#[derive(Default)]
pub(crate) struct WorkOffer {
    card: Option<Card>,
}

struct Card {
    request: String,
    question: Question,
    version: i64,
    settled: bool,
}

impl WorkOffer {
    pub(crate) fn refresh(
        &mut self,
        output: &Output,
        session: &str,
        detail: &Detail,
        writable: bool,
    ) -> Result<(), Failure> {
        let Some(question @ Question::Work { prompt, options }) = detail
            .question
            .as_ref()
            .filter(|_| writable && detail.version > 0 && !detail.phase.is_terminal())
        else {
            self.card = None;
            return Ok(());
        };
        if self
            .card
            .as_ref()
            .is_some_and(|card| card.question == *question)
        {
            return Ok(());
        }
        let mut properties = Map::new();
        if !options.is_empty() {
            properties.insert(
                "choice".into(),
                json!({
                    "type": "string", "title": "Option",
                    "oneOf": options.iter().map(|option| json!({
                        "const": option, "title": option
                    })).collect::<Vec<_>>()
                }),
            );
        }
        properties.insert(
            "guidance".into(),
            json!({"type":"string","title":"Guidance"}),
        );
        let required = if options.is_empty() {
            vec!["guidance"]
        } else {
            Vec::new()
        };
        let request = request_form(
            output,
            session,
            prompt,
            json!({"type":"object", "properties":properties, "required":required}),
        )?;
        self.card = Some(Card {
            request,
            question: question.clone(),
            version: detail.version,
            settled: false,
        });
        Ok(())
    }

    pub(crate) fn take_answer(&mut self, response: &Value) -> Option<(Command, i64)> {
        let card = self.card.as_mut()?;
        if card.settled || response["id"] != card.request {
            return None;
        }
        card.settled = true;
        let result = &response["result"];
        if result["action"] != "accept" {
            return None;
        }
        let Question::Work { options, .. } = &card.question else {
            return None;
        };
        let choice = result["content"]["choice"].as_str().unwrap_or_default();
        if !choice.is_empty() && !options.iter().any(|option| option == choice) {
            return None;
        }
        let guidance = result["content"]["guidance"]
            .as_str()
            .unwrap_or_default()
            .trim();
        let instruction = [choice, guidance]
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        (!instruction.is_empty())
            .then_some((Command::Answer(Answer::Work(instruction)), card.version))
    }

    pub(crate) fn withdrawn(&mut self) {
        self.card = None;
    }
}
