use std::{
    num::NonZeroU64,
    time::{Duration, UNIX_EPOCH},
};

use nucleus_core::Review;
use nucleus_store::{
    EngineStorage, ReviewIntent, ReviewPublication, ReviewPublicationOutcome as Outcome, Store,
    StoreError,
};
use rusqlite::{Connection, params};

use super::{event, fixture_storage, task};

fn v12() -> (tempfile::TempDir, EngineStorage, Connection) {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    store.create(&task("one", "#1"), &event("created")).unwrap();
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch("DROP TABLE review_publications; PRAGMA user_version=12")
        .unwrap();
    (home, storage, db)
}

fn publication(instance: String, outcome: Outcome, at: i64) -> ReviewPublication {
    ReviewPublication {
        intent: ReviewIntent {
            instance,
            pull_url: "https://github.com/example/fixture/pull/3".into(),
            head: "1".repeat(40).parse().unwrap(),
            decision: Review::Approve,
            author: NonZeroU64::new(12).unwrap(),
            pull_author: NonZeroU64::new(15).unwrap(),
            body_digest: "f".repeat(64),
        },
        outcome,
        response: Some("original confirmation".into()),
        recorded_at: at,
    }
}

fn insert(db: &Connection, at: i64, detail: &str) -> i64 {
    db.execute(
        "INSERT INTO events (task_id,at,kind,detail) VALUES ('one',?1,'review_publication',?2)",
        params![at, detail],
    )
    .unwrap();
    db.last_insert_rowid()
}

#[test]
fn v12_publications_keep_each_instances_last_sequence_and_write_allowance() {
    let (_home, storage, db) = v12();
    let future = UNIX_EPOCH + Duration::from_secs(4_000_000_000);
    let id = NonZeroU64::new(7).unwrap();
    let cases = [
        (Outcome::Pending, Some(Outcome::Resubmitted)),
        (Outcome::Resubmitted, Some(Outcome::FinalAttempt)),
        (Outcome::FinalAttempt, None),
        (Outcome::Deferred(future), None),
        (Outcome::ResubmissionDeferred(future), None),
        (Outcome::FinalAttemptDeferred(future), None),
        (Outcome::Submitted(id), None),
        (Outcome::Verified(id), None),
        (Outcome::AccessRefused, None),
        (Outcome::Refused, None),
    ];
    let mut expected = Vec::new();
    for (index, (outcome, next)) in cases.into_iter().enumerate() {
        let mut row = publication(format!("review-{index}"), Outcome::Pending, 900);
        insert(&db, row.recorded_at, &serde_json::to_string(&row).unwrap());
        row.outcome = outcome;
        row.recorded_at = 20;
        insert(&db, row.recorded_at, &serde_json::to_string(&row).unwrap());
        expected.push((row, next));
    }
    drop(db);
    for _ in 0..2 {
        let store = Store::open(&storage).unwrap();
        assert!(
            store
                .review_publication("one", "pre-feature")
                .unwrap()
                .is_none()
        );
        for (row, _) in &expected {
            assert_eq!(
                store
                    .review_publication("one", &row.intent.instance)
                    .unwrap()
                    .as_ref(),
                Some(row)
            );
        }
        let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
        let audit: i64 = db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='review_publication'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(audit, i64::try_from(2 * expected.len()).unwrap());
    }
    let mut store = Store::open(&storage).unwrap();
    for (row, next) in expected {
        assert_eq!(
            store
                .claim_review_publication("one", &row.intent, Some(&row), 1000)
                .unwrap(),
            next
        );
    }
}

#[test]
fn corrupt_superseded_publication_rolls_back_the_whole_upgrade() {
    let (_home, storage, db) = v12();
    let row = publication("reviewer".into(), Outcome::FinalAttempt, 12);
    let good = serde_json::to_string(&row).unwrap();
    insert(&db, 1, &good);
    let bad = insert(&db, 2, &good.replace("final_attempt", "unrecognized"));
    insert(&db, 3, &good);
    drop(db);
    assert!(
        matches!(Store::open(&storage), Err(StoreError::InvalidPublicationEvent {task,sequence}) if task == "one" && sequence == bad)
    );
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
            .unwrap(),
        12
    );
    assert!(
        !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='review_publications')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap()
    );
}
