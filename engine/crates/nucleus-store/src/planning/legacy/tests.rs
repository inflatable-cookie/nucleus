use serde_json::json;
use sha2::Digest as _;

use super::*;

const DATE: &str = "2026-11-24T09:00:00.321Z";
const OLDER: &str = "An earlier idea\r\nKeep this line\n";
const CURRENT: &str = "An improved idea\nKeep this line\n";

fn legacy_copy(root: &Path) -> PathBuf {
    let path = root.join("legacy-copy.sqlite");
    let source = Connection::open(&path).expect("legacy fixture");
    source.execute_batch("
        CREATE TABLE leads (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE papercuts (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE lead_versions (leadId TEXT, version INTEGER, data TEXT);
        CREATE TABLE lead_version_deltas (
            leadId TEXT, version INTEGER, baseVersion INTEGER, bodyDigest TEXT, data TEXT, delta TEXT
        );",
    ).expect("legacy schema");
    let common = json!({
        "id": "idea", "title": "Improve the plan", "state": "open",
        "version": 2, "author": "legacy-planner", "createdAt": DATE, "updatedAt": DATE,
        "repositories": [{"origin":"example/fixture","path":"/synthetic/repo"}],
        "lanes":["ui"], "parked":{"reason":"Waiting for a decision","revisitAt":DATE},
    });
    source
        .execute("INSERT INTO leads VALUES ('idea',?1)", [common.to_string()])
        .expect("lead");
    let mut cut = common;
    cut["id"] = json!("promoted");
    cut["body"] = json!("A papercut.");
    cut["state"] = json!("promoted");
    cut["tags"] = json!(["papercut"]);
    cut["parked"] = Value::Null;
    cut["targets"] = json!([
        {"kind":"task","repository":"example/fixture","reference":"task-2"},
        {"kind":"task","repository":"example/fixture","reference":"task-1"},
        {"kind":"knowledge","repository":null,"reference":"docs/synthetic.md"},
    ]);
    source
        .execute(
            "INSERT INTO leads VALUES ('promoted',?1)",
            [cut.to_string()],
        )
        .expect("unified papercut");
    let older_cut = json!({
        "id":"closed","title":"Earlier fix","repository":{"origin":"example/fixture"},
        "happened":"Discovered a bug","impact":"Delayed work","fix":"Correct it",
        "filedBy":"legacy-operator","filedAt":DATE,"state":"closed","taskId":"task-3",
        "closedReason":"completed","closedAt":DATE,"note":"Removed the cause",
    });
    source
        .execute(
            "INSERT INTO papercuts VALUES ('closed',?1)",
            [older_cut.to_string()],
        )
        .expect("standalone papercut");
    source
        .execute(
            "INSERT INTO papercuts VALUES ('promoted','stale duplicate')",
            [],
        )
        .expect("same ID already unified");
    let current_digest = format!("sha256:{:x}", sha2::Sha256::digest(CURRENT));
    let older_digest = format!("sha256:{:x}", sha2::Sha256::digest(OLDER));
    let snapshot = json!({
        "version":2,"title":"Improve the plan","body":CURRENT,
        "author":"legacy-editor","createdAt":DATE,"digest":current_digest,
    });
    source
        .execute(
            "INSERT INTO lead_versions VALUES ('idea', 2, ?1)",
            [snapshot.to_string()],
        )
        .expect("full version");
    let snapshot = json!({
        "version":1,"title":"Original plan","author":"legacy-planner","createdAt":DATE,
        "digest":older_digest,
    });
    let delta = json!({
        "format":"queue.reverse-lines","formatVersion":1,"baseVersion":2,"targetVersion":1,
        "baseDigest":current_digest,"targetDigest":older_digest,"baseBytes":CURRENT.len(),
        "targetBytes":OLDER.len(),"lines":["An earlier idea\r\n"],"ops":[[1,0,1],[0,1,1]],
    });
    source
        .execute(
            "INSERT INTO lead_version_deltas VALUES ('idea',1,2,?1,?2,?3)",
            rusqlite::params![older_digest, snapshot.to_string(), delta.to_string()],
        )
        .expect("reverse delta");
    path
}

fn mapping() -> BTreeMap<String, String> {
    BTreeMap::from([("example/fixture".into(), "fixture".into())])
}

#[test]
fn legacy_planning_import_rehearses_and_keeps_verified_history_and_links() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = legacy_copy(scratch.path());
    let bytes = fs::read(&source).expect("source bytes");
    let rehearsal =
        import_items(scratch.path(), &source, &mapping(), ImportMode::Rehearse).expect("rehearse");
    assert!(rehearsal.database.is_none());
    assert_eq!(fs::read_dir(scratch.path()).expect("scratch").count(), 1);
    assert_eq!(
        (
            rehearsal.leads,
            rehearsal.papercuts,
            rehearsal.versions,
            rehearsal.task_links
        ),
        (1, 2, 2, 3)
    );

    let imported =
        import_items(scratch.path(), &source, &mapping(), ImportMode::Keep).expect("import");
    let store = Store::open_database(&imported.database.expect("kept copy")).expect("open copy");
    let item = |id| store.item("fixture", id).expect("item read").expect("item");
    assert_eq!(item("idea").content.body, CURRENT);
    assert_eq!(item("idea").author, "legacy-planner");
    assert_eq!(
        item("idea").state,
        ItemState::Parked {
            reason: "Waiting for a decision".into(),
            revisit_at: Some(DATE.into())
        }
    );
    assert_eq!(item("promoted").kind, ItemKind::Papercut);
    assert_eq!(
        item("promoted").state,
        ItemState::Promoted {
            task_id: "task-2".into()
        }
    );
    assert_eq!(item("promoted").task_links, ["task-2", "task-1"]);
    assert_eq!(
        item("closed").state,
        ItemState::Dropped {
            reason: Some("Removed the cause".into())
        }
    );
    assert_eq!(item("closed").task_links, ["task-3"]);
    let history = store
        .planning_history("fixture", ItemRecord, "idea")
        .expect("history");
    assert_eq!(history.len(), 4);
    assert_eq!(history[0].snapshot["body"], OLDER);
    assert_eq!(history[1].actor, "legacy-editor");
    assert_eq!(history[1].at_ms % 1000, 321);
    assert_eq!(fs::read(&source).expect("unchanged source"), bytes);
}

#[test]
fn legacy_planning_import_refuses_external_links_and_corrupt_history() {
    let external = tempfile::tempdir().expect("other scratch");
    let scratch = tempfile::tempdir().expect("scratch");
    let outside = legacy_copy(external.path());
    let link = scratch.path().join("external.sqlite");
    std::os::unix::fs::symlink(outside, &link).expect("outside link");
    assert!(matches!(
        import_items(scratch.path(), &link, &mapping(), ImportMode::Keep),
        Err(ImportError::Source)
    ));
    let source = legacy_copy(scratch.path());
    let db = Connection::open(&source).expect("fixture");
    db.execute("UPDATE lead_version_deltas SET bodyDigest = 'corrupt'", [])
        .expect("corrupt digest");
    drop(db);
    assert!(matches!(
        import_items(scratch.path(), &source, &mapping(), ImportMode::Keep),
        Err(ImportError::History { version: 1, .. })
    ));
    assert_eq!(fs::read_dir(scratch.path()).expect("scratch").count(), 2);
}
