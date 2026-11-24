use nucleus_core::{Entry, Identity, Role, Task};
use serde_json::json;
use sha2::Digest as _;

use super::*;
use crate::{EngineSettings, EventDraft, Profiles, SettingsFile, planning::ItemSource};

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

fn profile(root: &Path) -> SettingsFile {
    let home = root.canonicalize().expect("scratch root").join("profile");
    fs::create_dir(&home).expect("profile directory");
    let settings = SettingsFile::open(&home).expect("settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            ..EngineSettings::default()
        })
        .expect("enable synthetic profile");
    settings
}

fn legacy_profile(id: &str) -> Value {
    json!({
        "id":id, "name":id, "provider":"claude", "model":"model",
        "providerInstanceId":"claude-fixture", "thinkingOptionId":"ultra", "modeId":"accept-edits",
        "featureValues":{"speed":"priority","legacy-option":{"preserve":true}},
        "notes":"Fixture notes",
    })
}

fn legacy_pool(id: &str) -> Value {
    json!({
        "profileId":id, "enabled":true, "group":"subscription",
        "roles":["reviewer","coordinator"], "capability":"heavyweight", "weight":"fewer",
        "scopes":["general","complex"],
    })
}

fn add_profile_meta(source: &Path, profiles: Value, pool: Value) {
    let source = Connection::open(source).expect("synthetic copy");
    source
        .execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
        .expect("meta");
    for (key, value) in [("profiles", profiles), ("pool", pool)] {
        source
            .execute(
                "INSERT INTO meta VALUES (?1, ?2)",
                params![key, value.to_string()],
            )
            .expect("legacy metadata");
    }
}

fn assert_imported_profiles(before: &Profiles, first: &Profiles) {
    let [seed, disabled, draft] = first.profiles.as_slice() else {
        panic!("expected all representable source profiles");
    };
    assert_eq!(seed.selection, before.profiles[0].selection);
    assert_eq!(seed.group, before.profiles[0].group);
    assert_eq!(seed.provider_instance_id.as_deref(), Some("claude-fixture"));
    assert_eq!(seed.mode_id.as_deref(), Some("accept-edits"));
    assert_eq!(seed.scopes, ["general", "complex"]);
    assert_eq!(
        json!(seed.feature_values),
        legacy_profile("seed")["featureValues"]
    );
    assert!(seed.eligible_for(Role::Reviewer));
    assert!(!seed.eligible_for(Role::Worker));
    assert!(disabled.unrated);
    assert_eq!(
        disabled.roles.as_deref(),
        Some([crate::PoolRole::Worker].as_slice())
    );
    assert!(!disabled.eligible_for(Role::Worker));
    assert!(!draft.enabled);
    assert_eq!(first.paused_groups, before.paused_groups);
}

#[test]
fn legacy_profiles_only_uses_the_service_lock_without_opening_the_database() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = scratch.path().join("profiles-copy.sqlite");
    add_profile_meta(
        &source,
        json!([legacy_profile("seed")]),
        json!([legacy_pool("seed")]),
    );
    let bytes = fs::read(&source).expect("source");
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    let lock = storage.lock_profile().expect("running");
    let database = storage.database().path().join(DATABASE_FILE);
    fs::write(&database, b"opaque fixture").expect("unopened database");
    assert!(matches!(
        apply_profiles(scratch.path(), &source, &settings),
        Err(ImportError::Storage(StorageError::ProfileLock))
    ));
    assert!(!settings.read::<Profiles>().expect("locked").configured);
    drop(lock);

    let report = apply_profiles(scratch.path(), &source, &settings).expect("profiles only");
    let report = serde_json::to_value(report).expect("report");
    assert_eq!(report["profiles"]["added"], 1);
    assert_eq!(report["database"], Value::Null);
    assert_eq!(fs::read(&database).expect("database"), b"opaque fixture");
    assert_eq!(fs::read(&source).expect("source"), bytes);
}

#[test]
fn legacy_profiles_enrich_exact_seeds_and_replay_without_clobbering_edits() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = legacy_copy(scratch.path());
    let mut disabled = legacy_pool("disabled");
    disabled["enabled"] = json!(false);
    disabled["capability"] = Value::Null;
    disabled.as_object_mut().expect("pool").remove("roles");
    let mut draft = legacy_profile("draft");
    draft["model"] = json!("");
    let mut unknown = legacy_profile("unknown");
    unknown["provider"] = json!("future-provider");
    add_profile_meta(
        &source,
        json!([
            legacy_profile("seed"),
            legacy_profile("disabled"),
            draft,
            unknown
        ]),
        json!([
            legacy_pool("seed"),
            disabled,
            legacy_pool("unknown"),
            legacy_pool("orphan")
        ]),
    );
    let bytes = fs::read(&source).expect("source");
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    drop(Store::open(&storage).expect("engine database"));
    settings
        .edit::<Profiles>("default", |current| {
            *current = serde_json::from_value(json!({
                "profiles":[{
                    "name":"seed","group":"subscription",
                    "selection":{"id":"seed","provider":"claude","model":"model","effort":"ultra",
                                 "capability":"heavyweight","weight":"fewer"}
                }],
                "pausedGroups":["subscription"],
            }))
            .expect("old Profiles JSON");
            Ok(())
        })
        .expect("seed settings");
    let before = settings.read::<Profiles>().expect("old profiles");
    assert!(before.value.profiles[0].eligible_for(Role::Worker));

    let lock = storage.lock_profile().expect("running");
    assert!(matches!(
        apply_items(scratch.path(), &source, &mapping(), &settings),
        Err(ImportError::Storage(StorageError::ProfileLock))
    ));
    assert_eq!(
        settings.read::<Profiles>().expect("locked").revision,
        before.revision
    );
    drop(lock);

    let apply = || {
        let report = apply_items(scratch.path(), &source, &mapping(), &settings).expect("apply");
        serde_json::to_value(report).expect("report")["profiles"].clone()
    };
    let report = apply();
    assert_eq!(report["added"], 2);
    assert_eq!(report["enriched"], 1);
    assert_eq!(report["unmapped"].as_array().expect("unmapped").len(), 2);
    assert_eq!(report["retained"][0]["notes"], "Fixture notes");
    assert_eq!(report["retained"][0]["coordinator"], true);
    assert_eq!(
        report["retained"][0]["featureValues"]["legacy-option"],
        json!({"preserve":true})
    );

    let first = settings.read::<Profiles>().expect("imported settings");
    assert_imported_profiles(&before.value, &first.value);
    assert_eq!(apply()["skipped"], 3);
    assert_eq!(
        settings.read::<Profiles>().expect("identical").revision,
        first.revision
    );

    let (edited, _) = settings
        .edit::<Profiles>(&first.revision, |current| {
            current.profiles[0].name = "Operator name".into();
            Ok(())
        })
        .expect("edit imported settings");
    let report = apply();
    assert_eq!(report["skipped"], 2);
    assert_eq!(report["conflicts"][0]["profile"]["id"], "seed");
    assert_eq!(
        settings
            .read::<Profiles>()
            .expect("preserved edit")
            .revision,
        edited.revision
    );
    assert_eq!(fs::read(&source).expect("source after replay"), bytes);
}

fn task(id: &str, brief: &str) -> Task {
    Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        brief.into(),
        None,
    )
}

fn admitted() -> EventDraft {
    EventDraft {
        at: 1,
        kind: "admitted".into(),
        detail: String::new(),
    }
}

const EDITED: WriteAt<'_> = WriteAt {
    actor: "rust-planner",
    at_ms: 1,
};

#[test]
fn legacy_planning_apply_preserves_tasks_and_replays_after_rust_edits() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = legacy_copy(scratch.path());
    let source_bytes = fs::read(&source).expect("source bytes");
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    let mut store = Store::open(&storage).expect("engine database");
    store
        .create(&task("pilot", "Keep this Rust task."), &admitted())
        .expect("pilot task");
    let pilot = store.row("pilot").expect("read pilot");
    drop(store);

    let running = storage.lock_profile().expect("service profile lock");
    assert!(matches!(
        apply_items(scratch.path(), &source, &mapping(), &settings),
        Err(ImportError::Storage(StorageError::ProfileLock))
    ));
    drop(running);
    let store = Store::open(&storage).expect("inspect refused apply");
    assert!(store.items("fixture").expect("items").is_empty());
    drop(store);

    let first = apply_items(scratch.path(), &source, &mapping(), &settings).expect("apply import");
    assert_eq!((first.leads, first.papercuts, first.skipped), (1, 2, 0));
    let mut store = Store::open(&storage).expect("open applied profile");
    assert_eq!(store.row("pilot").expect("pilot after apply"), pilot);
    let source_link = ItemSource {
        project_id: "fixture".into(),
        item_id: "idea".into(),
    };
    let revised = store
        .edit_item(
            "fixture",
            "idea",
            ItemContent {
                title: "Rust edit".into(),
                body: "A revised task brief.".into(),
                lanes: Vec::new(),
            },
            EDITED,
        )
        .expect("edit imported item");
    let (promoted, _) = store
        .promote_item(
            &source_link,
            &task("rust-promotion", &revised.content.body),
            &admitted(),
            EDITED,
        )
        .expect("link imported item to a new Rust task");
    let history = store
        .planning_history("fixture", ItemRecord, "idea")
        .expect("post-edit history");
    drop(store);

    let replay = apply_items(scratch.path(), &source, &mapping(), &settings).expect("replay");
    assert_eq!(
        (
            replay.leads,
            replay.papercuts,
            replay.versions,
            replay.task_links,
            replay.skipped
        ),
        (0, 0, 0, 0, 3)
    );
    let store = Store::open(&storage).expect("open replayed profile");
    assert_eq!(store.row("pilot").expect("pilot after replay"), pilot);
    assert_eq!(
        store.item("fixture", "idea").expect("preserved item"),
        Some(promoted)
    );
    assert_eq!(
        store.task_source("rust-promotion").expect("preserved link"),
        Some(source_link)
    );
    assert_eq!(
        store
            .planning_history("fixture", ItemRecord, "idea")
            .expect("unchanged history"),
        history
    );
    assert_eq!(
        fs::read(&source).expect("unchanged source bytes"),
        source_bytes
    );
}

#[test]
fn legacy_planning_apply_rolls_back_on_a_native_item_collision() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = legacy_copy(scratch.path());
    add_profile_meta(&source, json!([legacy_profile("worker")]), json!([]));
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    let mut store = Store::open(&storage).expect("engine database");
    let existing = store
        .add_item(
            "fixture",
            "closed".into(),
            ItemKind::Papercut,
            ItemContent {
                title: "A native item".into(),
                body: "Keep the native item and roll back the rest.".into(),
                lanes: Vec::new(),
            },
            EDITED,
        )
        .expect("existing item");
    drop(store);

    assert!(matches!(
        apply_items(scratch.path(), &source, &mapping(), &settings),
        Err(ImportError::Collision { project, id }) if project == "fixture" && id == "closed"
    ));
    let store = Store::open(&storage).expect("open after collision");
    assert_eq!(store.items("fixture").expect("unchanged items"), [existing]);
    assert!(!settings.read::<Profiles>().expect("settings").configured);
    assert!(
        store
            .planning_history("fixture", ItemRecord, "idea")
            .expect("no partial history")
            .is_empty()
    );
}

#[test]
fn legacy_planning_apply_requires_an_existing_engine_database() {
    let scratch = tempfile::tempdir().expect("scratch");
    let source = legacy_copy(scratch.path());
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    storage
        .database()
        .ensure()
        .expect("empty database directory");
    let database = storage.database().path().join(DATABASE_FILE);
    assert!(apply_items(scratch.path(), &source, &mapping(), &settings).is_err());
    assert!(!database.exists());
    fs::write(&database, []).expect("uninitialized file");
    assert!(matches!(
        apply_items(scratch.path(), &source, &mapping(), &settings),
        Err(ImportError::Store(StoreError::Incompatible {
            application: 0,
            version: 0
        }))
    ));
    assert_eq!(database.metadata().expect("uninitialized file").len(), 0);
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

fn project_copy(root: &Path) -> (PathBuf, BTreeMap<String, String>) {
    let path = legacy_copy(root);
    let source = Connection::open(&path).expect("legacy fixture");
    source.execute_batch(
        "CREATE TABLE projects (key TEXT PRIMARY KEY, data TEXT);
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE lanes (key TEXT PRIMARY KEY, data TEXT);
         CREATE TABLE project_plans (project TEXT, version INTEGER, data TEXT);
         CREATE TABLE lane_documents (lane TEXT, version INTEGER, data TEXT);
         CREATE TABLE lane_document_deltas (lane TEXT, version INTEGER, baseVersion INTEGER, bodyDigest TEXT, data TEXT, delta TEXT);
         INSERT INTO meta VALUES ('projectLimit', '4'), ('projectDispatchLimitOverrides', '{\"product\":7}');
         INSERT INTO lane_documents SELECT 'ui', version, json_set(json_remove(data,'$.body'),'$.key','ui','$.text',data->>'body')
           FROM lead_versions WHERE leadId = 'idea';
         INSERT INTO lane_document_deltas SELECT 'ui', version, baseVersion, bodyDigest, json_set(data,'$.key','ui'), delta
           FROM lead_version_deltas WHERE leadId = 'idea';",
    ).expect("project and lane history schema");
    let repositories = json!([
        {"origin":"example/fixture","path":"/synthetic/repo"},
        {"origin":"example/other","path":"/synthetic/other"},
    ]);
    let project = json!({"key":"product","name":"A product","repositories":repositories});
    let lane = json!({
        "key":"ui","title":"Design","aim":"Finish the board",
        "status":"active","repositories":repositories,"updatedAt":DATE,
    });
    let plan = json!({
        "project":"product","version":1,"entries":[{"lane":"ui","note":"Working","horizon":"next","doneWhen":"Board ships"}],
        "author":"legacy-editor","createdAt":DATE,
    });
    let mut item_repos = repositories.as_array().expect("repositories").clone();
    item_repos.push(json!({"origin":"example/historic","path":"/synthetic/old"}));
    source
        .execute(
            "INSERT INTO projects VALUES ('product',?1)",
            [project.to_string()],
        )
        .expect("project");
    source
        .execute("INSERT INTO lanes VALUES ('ui',?1)", [lane.to_string()])
        .expect("lane");
    source
        .execute(
            "INSERT INTO project_plans VALUES ('product',1,?1)",
            [plan.to_string()],
        )
        .expect("plan");
    source
        .execute(
            "UPDATE leads SET data = json_set(data, '$.repositories', json(?1)) WHERE id = 'idea'",
            [Value::Array(item_repos).to_string()],
        )
        .expect("multi-project item");
    let mapping = ["example/fixture", "example/other", "example/historic"]
        .into_iter()
        .map(|origin| (origin.to_owned(), registry::old_key(origin)))
        .collect();
    (path, mapping)
}

fn edit_prior_project_items(store: &mut Store, from: &str, other: &str) -> (ItemContent, i64) {
    let mut edit = store
        .item(from, "idea")
        .expect("read source")
        .expect("imported item")
        .content;
    edit.title = "Edited in the first repository".into();
    store
        .edit_item(from, "idea", edit.clone(), EDITED)
        .expect("edit title");
    let mut second_edit = store
        .item(other, "idea")
        .expect("read sibling")
        .expect("imported item")
        .content;
    second_edit.body = "Edited in the second repository.".into();
    store
        .edit_item(other, "idea", second_edit, EDITED)
        .expect("edit body");
    let (_, number) = store
        .promote_item(
            &ItemSource {
                project_id: from.into(),
                item_id: "idea".into(),
            },
            &task("promotion", &edit.body),
            &admitted(),
            EDITED,
        )
        .expect("promote first copy");
    (edit, number)
}

#[test]
fn project_import_coalesces_compatible_edits_and_preserves_promotion_and_number() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (source, mapping) = project_copy(scratch.path());
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    drop(Store::open(&storage).expect("initialize engine"));
    apply_items(scratch.path(), &source, &mapping, &settings).expect("prior import");

    let from = &mapping["example/fixture"];
    let other = &mapping["example/other"];
    let mut store = Store::open(&storage).expect("open before rekey");
    let (edit, number) = edit_prior_project_items(&mut store, from, other);
    drop(store);

    let report = import_projects(scratch.path(), &source, Some(&settings)).expect("apply registry");
    assert_eq!(
        (
            report.projects,
            report.repositories,
            report.rekeyed_items,
            report.coalesced_items
        ),
        (1, 2, 4, 1)
    );
    let registry = settings
        .read::<crate::Projects>()
        .expect("project settings");
    let product = &registry.value.projects["product"];
    assert_eq!(
        (&*product.name, product.slots, product.repositories.len()),
        ("A product", 7, 2)
    );
    let historical = format!("legacy.{}", mapping["example/historic"]);
    assert!(registry.value.projects[&historical].archived);

    let mut store = Store::open(&storage).expect("open migrated engine");
    let item = store
        .item("product", "idea")
        .expect("read")
        .expect("rekeyed item");
    assert_eq!(item.content.title, edit.title);
    // Preserve the other copy's edit as well as the source of the first copy's task.
    assert_eq!(item.content.body, "Edited in the second repository.");
    assert_eq!(item.repositories, ["example/fixture", "example/other"]);
    assert!(matches!(item.state, ItemState::Promoted { ref task_id } if task_id == "promotion"));
    assert!(store.item(from, "idea").expect("old scope").is_none());
    assert!(
        store
            .item(&historical, "idea")
            .expect("old repository history")
            .is_some()
    );
    assert_eq!(
        store
            .task_source("promotion")
            .expect("task link")
            .expect("source")
            .project_id,
        "product"
    );
    assert_eq!(
        store
            .row("promotion")
            .expect("read task")
            .expect("task")
            .number,
        Some(number)
    );
    let history = store
        .planning_history("product", ItemRecord, "idea")
        .expect("item history");
    assert_eq!(history.iter().filter(|row| row.action == "edit").count(), 2);
    assert_eq!(
        store.plan("product").expect("plan").lanes[0].done_when,
        "Board ships"
    );
    let lane = store
        .lanes("product")
        .expect("lane")
        .pop()
        .expect("lane record");
    assert_eq!(lane.document.document, CURRENT);
    let docs = store
        .planning_history("product", crate::planning::RecordKind::Lane, "ui")
        .expect("documents");
    assert!(docs.iter().any(|entry| entry.snapshot["text"] == OLDER));

    store
        .edit_item("product", "idea", edit, EDITED)
        .expect("edit after migration");
    let after = store
        .planning_history("product", ItemRecord, "idea")
        .expect("post-migration history");
    drop(store);
    assert!(
        import_projects(scratch.path(), &source, Some(&settings))
            .expect("replay")
            .already_applied
    );
    let store = Store::open(&storage).expect("open replay");
    assert_eq!(
        store
            .planning_history("product", ItemRecord, "idea")
            .expect("replayed history"),
        after
    );
}

#[test]
fn project_import_refuses_divergent_edits_without_publishing_either_store() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (source, mapping) = project_copy(scratch.path());
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    drop(Store::open(&storage).expect("initialize engine"));
    apply_items(scratch.path(), &source, &mapping, &settings).expect("prior import");
    let mut store = Store::open(&storage).expect("open before rekey");
    for origin in ["example/fixture", "example/other"] {
        let project = &mapping[origin];
        let mut content = store
            .item(project, "idea")
            .expect("read")
            .expect("existing item")
            .content;
        content.body = origin.into();
        store
            .edit_item(project, "idea", content, EDITED)
            .expect("edit copy");
    }
    drop(store);
    assert!(matches!(
        import_projects(scratch.path(), &source, Some(&settings)),
        Err(ImportError::ProjectConflict(conflict)) if conflict.contains("different body edits")
    ));
    assert!(
        !settings
            .read::<crate::Projects>()
            .expect("settings")
            .configured
    );
    let store = Store::open(&storage).expect("no pending journal");
    assert!(store.items("product").expect("target").is_empty());
    assert!(
        store
            .item(&mapping["example/fixture"], "idea")
            .expect("source")
            .is_some()
    );
}

#[test]
fn project_import_resumes_pending_settings_before_the_engine_reopens() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (source, mapping) = project_copy(scratch.path());
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    let store = Store::open(&storage).expect("initialize engine");
    let revision = settings
        .read::<crate::Projects>()
        .expect("registry")
        .revision;
    let pending = json!({
        "revision": revision,
        "registry": {"projects": {"product": {
            "name": "Imported product", "slots": 7, "archived": true, "repositories": []
        }}}
    });
    store
        .connection
        .execute(
            "INSERT INTO legacy_project_import (singleton, pending) VALUES (1, ?1)",
            [pending.to_string()],
        )
        .expect("durable pending publication");
    drop(store);
    assert!(matches!(
        Store::open(&storage),
        Err(StoreError::ProjectImportPending)
    ));
    assert!(matches!(
        apply_items(scratch.path(), &source, &mapping, &settings),
        Err(ImportError::Store(StoreError::ProjectImportPending))
    ));

    let result = import_projects(scratch.path(), &source, Some(&settings)).expect("resume");
    assert!(result.resumed);
    assert_eq!(
        settings
            .read::<crate::Projects>()
            .expect("saved registry")
            .value
            .projects["product"]
            .slots,
        7
    );
    assert!(Store::open(&storage).is_ok());
}

#[test]
fn project_import_preserves_an_explicit_rust_slot_limit() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (source, _) = project_copy(scratch.path());
    let settings = profile(scratch.path());
    let storage = settings.storage().expect("storage");
    drop(Store::open(&storage).expect("initialize engine"));
    let project_settings = || {
        settings
            .read::<crate::Projects>()
            .expect("project settings")
    };
    settings
        .edit(
            &project_settings().revision,
            |projects: &mut crate::Projects| {
                projects.projects.insert(
                    "product".into(),
                    crate::ProjectSettings {
                        name: "A product".into(),
                        slots: 2,
                        archived: false,
                        repositories: Vec::new(),
                    },
                );
                Ok(())
            },
        )
        .expect("existing pilot override");

    import_projects(scratch.path(), &source, Some(&settings)).expect("apply registry");
    let applied = project_settings();
    assert_eq!(applied.value.projects["product"].slots, 2);
    assert_eq!(applied.value.projects["product"].repositories.len(), 2);
    assert!(
        import_projects(scratch.path(), &source, Some(&settings))
            .expect("replay")
            .already_applied
    );
    assert_eq!(project_settings().revision, applied.revision);
}
