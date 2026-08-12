//! Editor file domain tests, split from the editor_files god file; behavior
//! unchanged.

use super::*;

use crate::seed_local_project;
use crate::LocalProjectSeed;
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation, SqliteBackend};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload,
    ProjectResourceStorageLocationStatus,
};

use super::discovery::file_ref;

use crate::ServerStateService;

fn fixture() -> (tempfile::TempDir, ServerStateService<SqliteBackend>) {
    let dir = tempfile::tempdir().expect("dir");
    let state = ServerStateService::new(SqliteBackend::new(dir.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed");
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("seed resource");
    resource.current_locator = Some(dir.path().to_string_lossy().into_owned());
    resource.location_status = ProjectResourceStorageLocationStatus::Present;
    record.revision_id = RevisionId("rev:editor-test".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");
    (dir, state)
}

#[test]
fn discovery_read_save_and_conflict_are_project_scoped() {
    let (dir, state) = fixture();
    std::fs::write(dir.path().join("demo.rs"), "fn main() {}\n").expect("write");
    std::fs::write(dir.path().join("binary.bin"), b"a\0b").expect("binary");
    std::fs::create_dir(dir.path().join("target")).expect("target");
    std::fs::write(dir.path().join("target/hidden.rs"), "hidden").expect("hidden");
    std::fs::write(dir.path().join(".gitignore"), "ignored.rs\n").expect("ignore file");
    std::fs::write(dir.path().join("ignored.rs"), "ignored").expect("ignored");
    let oversized = std::fs::File::create(dir.path().join("oversized.txt")).expect("oversized");
    oversized.set_len(MAX_EDITOR_FILE_BYTES + 1).expect("size");

    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", dir.path().join("outside.txt"))
        .expect("outside symlink");

    let files = list_editor_files(&state, "project:nucleus-local", None).expect("list");
    assert!(files.iter().any(|file| file.display_path == "demo.rs"));
    assert!(!files.iter().any(|file| matches!(
        file.display_path.as_str(),
        "ignored.rs" | "oversized.txt" | "outside.txt" | "target/hidden.rs" | "binary.bin"
    )));
    assert!(read_editor_file(
        &state,
        "project:nucleus-local",
        None,
        "editor-file:invented",
    )
    .expect_err("invented ref")
    .contains("not found"));
    let demo = files
        .iter()
        .find(|file| file.display_path == "demo.rs")
        .expect("demo");
    let opened = read_editor_file_at_path(
        &state,
        "project:nucleus-local",
        None,
        &demo.file_ref,
        &demo.display_path,
    )
    .expect("direct admitted read");
    assert!(read_editor_file_at_path(
        &state,
        "project:nucleus-local",
        None,
        &file_ref("ignored.rs"),
        "ignored.rs",
    )
    .expect_err("ignored direct path")
    .contains("admitted directory"));
    let saved = save_editor_file(
        &state,
        &EditorFileSaveRequest {
            project_id: opened.project_id.clone(),
            resource_id: Some(opened.resource_id.clone()),
            file_ref: opened.file_ref.clone(),
            display_path: Some(opened.display_path.clone()),
            expected_content_revision: opened.content_revision.clone(),
            content: "fn main() { println!(\"ok\"); }\n".to_owned(),
        },
    )
    .expect("save");
    assert_ne!(saved.content_revision, opened.content_revision);
    assert!(saved.content.contains("println"));
    assert!(save_editor_file(
        &state,
        &EditorFileSaveRequest {
            project_id: opened.project_id,
            resource_id: Some(opened.resource_id),
            file_ref: opened.file_ref,
            display_path: Some(opened.display_path),
            expected_content_revision: opened.content_revision,
            content: "stale".to_owned(),
        }
    )
    .expect_err("conflict")
    .contains("conflict"));
}

#[test]
fn directory_discovery_only_reads_the_requested_level() {
    let (dir, state) = fixture();
    std::fs::create_dir_all(dir.path().join("src/nested")).expect("nested directories");
    std::fs::write(dir.path().join("README.md"), "root").expect("root file");
    std::fs::write(dir.path().join("src/lib.rs"), "pub fn demo() {}\n").expect("child file");
    std::fs::write(dir.path().join("src/nested/deep.rs"), "pub fn deep() {}\n")
        .expect("deep file");
    std::fs::write(dir.path().join("src/binary.bin"), b"a\0b").expect("binary file");

    let root =
        list_editor_directory(&state, "project:nucleus-local", None, None).expect("root");
    assert!(root.iter().any(|entry| {
        entry.kind == EditorDirectoryEntryKind::Directory && entry.display_path == "src"
    }));
    assert!(root.iter().any(|entry| {
        entry.kind == EditorDirectoryEntryKind::File && entry.display_path == "README.md"
    }));
    assert!(!root.iter().any(|entry| entry.display_path == "src/lib.rs"));

    let src =
        list_editor_directory(&state, "project:nucleus-local", None, Some("src")).expect("src");
    assert!(src.iter().any(|entry| {
        entry.kind == EditorDirectoryEntryKind::Directory && entry.display_path == "src/nested"
    }));
    assert!(src.iter().any(|entry| {
        entry.kind == EditorDirectoryEntryKind::File && entry.display_path == "src/lib.rs"
    }));
    assert!(!src.iter().any(|entry| matches!(
        entry.display_path.as_str(),
        "src/nested/deep.rs" | "src/binary.bin"
    )));
}

#[test]
fn create_rename_and_delete_stay_inside_admitted_project_files() {
    let (dir, state) = fixture();
    std::fs::create_dir(dir.path().join("src")).expect("src");

    let created = create_editor_file(
        &state,
        &EditorFileCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: "src/new.rs".to_owned(),
            content: "pub fn new() {}\n".to_owned(),
        },
    )
    .expect("create");
    assert_eq!(created.display_path, "src/new.rs");
    assert_eq!(created.content, "pub fn new() {}\n");
    assert!(create_editor_file(
        &state,
        &EditorFileCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: "src/new.rs".to_owned(),
            content: String::new(),
        },
    )
    .expect_err("create collision")
    .contains("exists"));

    let renamed = rename_editor_file(
        &state,
        &EditorFileRenameRequest {
            project_id: created.project_id.clone(),
            resource_id: Some(created.resource_id.clone()),
            file_ref: created.file_ref.clone(),
            display_path: created.display_path.clone(),
            target_display_path: "src/renamed.rs".to_owned(),
        },
    )
    .expect("rename");
    assert_eq!(renamed.display_path, "src/renamed.rs");
    assert_ne!(renamed.file_ref, created.file_ref);
    assert!(!dir.path().join("src/new.rs").exists());

    let deleted = delete_editor_file(
        &state,
        &EditorFileDeleteRequest {
            project_id: renamed.project_id.clone(),
            resource_id: Some(renamed.resource_id.clone()),
            file_ref: renamed.file_ref.clone(),
            display_path: renamed.display_path.clone(),
        },
    )
    .expect("delete");
    assert_eq!(deleted.display_path, "src/renamed.rs");
    assert!(!dir.path().join("src/renamed.rs").exists());

    assert!(create_editor_file(
        &state,
        &EditorFileCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: "../escaped.txt".to_owned(),
            content: String::new(),
        },
    )
    .expect_err("parent traversal")
    .contains("not admitted"));
    assert!(create_editor_file(
        &state,
        &EditorFileCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: ".git/escaped.txt".to_owned(),
            content: String::new(),
        },
    )
    .expect_err("hard excluded path")
    .contains("not admitted"));
}

#[test]
fn create_rename_and_delete_folders_return_editor_identity_changes() {
    let (dir, state) = fixture();
    std::fs::create_dir(dir.path().join("src")).expect("src");

    let created = create_editor_directory(
        &state,
        &EditorDirectoryCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: "src/generated".to_owned(),
        },
    )
    .expect("create folder");
    assert_eq!(created.display_path, "src/generated");
    std::fs::write(
        dir.path().join("src/generated/demo.rs"),
        "pub fn demo() {}\n",
    )
    .expect("nested file");

    let renamed = rename_editor_directory(
        &state,
        &EditorDirectoryRenameRequest {
            project_id: created.project_id.clone(),
            resource_id: Some(created.resource_id.clone()),
            display_path: created.display_path.clone(),
            target_display_path: "src/moved".to_owned(),
        },
    )
    .expect("rename folder");
    assert_eq!(renamed.target_display_path, "src/moved");
    assert_eq!(renamed.files.len(), 1);
    assert_eq!(renamed.files[0].display_path, "src/generated/demo.rs");
    assert_eq!(renamed.files[0].target_display_path, "src/moved/demo.rs");
    assert_ne!(renamed.files[0].file_ref, renamed.files[0].target_file_ref);
    assert!(dir.path().join("src/moved/demo.rs").exists());

    let deleted = delete_editor_directory(
        &state,
        &EditorDirectoryDeleteRequest {
            project_id: renamed.project_id,
            resource_id: Some(renamed.resource_id),
            display_path: renamed.target_display_path,
        },
    )
    .expect("delete folder");
    assert_eq!(deleted.files.len(), 1);
    assert_eq!(deleted.files[0].display_path, "src/moved/demo.rs");
    assert!(!dir.path().join("src/moved").exists());

    assert!(create_editor_directory(
        &state,
        &EditorDirectoryCreateRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            display_path: ".git/generated".to_owned(),
        },
    )
    .expect_err("hard excluded folder")
    .contains("not admitted"));
}

#[test]
fn quick_open_search_is_ranked_and_bounded() {
    let (dir, state) = fixture();
    std::fs::create_dir_all(dir.path().join("src/nested")).expect("directories");
    std::fs::write(dir.path().join("src/app.rs"), "app").expect("app");
    std::fs::write(dir.path().join("src/nested/app_helpers.rs"), "helpers")
        .expect("helpers");
    std::fs::write(dir.path().join("src/nested/my_app.rs"), "nested app")
        .expect("nested app");
    std::fs::write(dir.path().join("src/unrelated.rs"), "unrelated").expect("unrelated");

    let matches =
        search_editor_files(&state, "project:nucleus-local", None, "app", 2).expect("search");
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].display_path, "src/app.rs");
    assert_eq!(matches[1].display_path, "src/nested/app_helpers.rs");

    let empty =
        search_editor_files(&state, "project:nucleus-local", None, "", 1).expect("empty");
    assert_eq!(empty.len(), 1);
    assert_eq!(empty[0].display_path, "src/app.rs");
}

#[test]
fn explicit_resource_target_keeps_editor_reads_in_the_selected_root() {
    let (first, state) = fixture();
    let second = tempfile::tempdir().expect("second resource");
    std::fs::write(first.path().join("first.txt"), "first").expect("first file");
    std::fs::write(second.path().join("second.txt"), "second").expect("second file");
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let mut second_resource = project.resources[0].clone();
    second_resource.resource_id = "resource:second".to_owned();
    second_resource.display_name = "Second".to_owned();
    second_resource.current_locator = Some(second.path().to_string_lossy().into_owned());
    project.resources.push(second_resource);
    record.revision_id = RevisionId("rev:editor-multi-resource".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");

    let files = list_editor_files(&state, "project:nucleus-local", Some("resource:second"))
        .expect("list selected resource");
    assert!(files.iter().any(|file| file.display_path == "second.txt"));
    assert!(!files.iter().any(|file| file.display_path == "first.txt"));
    let second_entry = files
        .iter()
        .find(|file| file.display_path == "second.txt")
        .expect("second entry");
    let opened = read_editor_file(
        &state,
        "project:nucleus-local",
        Some("resource:second"),
        &second_entry.file_ref,
    )
    .expect("read selected resource");
    assert_eq!(opened.resource_id, "resource:second");
    assert_eq!(opened.content, "second");
}
