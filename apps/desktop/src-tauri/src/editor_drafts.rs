use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use nucleus_server::{EditorFileMoveReceipt, EditorFileSnapshot};
use serde::{Deserialize, Serialize};

use crate::DesktopState;

const SCHEMA_VERSION: u32 = 1;
const MAX_DRAFT_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SERIALIZED_DRAFT_BYTES: usize = 5 * 1024 * 1024;
static DRAFT_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDraftDto {
    pub schema_version: u32,
    pub snapshot: EditorFileSnapshot,
    pub content: String,
}

#[tauri::command]
pub async fn editor_draft_load(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: String,
    file_ref: String,
) -> Result<Option<EditorDraftDto>, String> {
    let root = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || load(&root, &project_id, &resource_id, &file_ref))
        .await
        .map_err(|_| "editor recovery draft worker failed".to_owned())?
}

#[tauri::command]
pub async fn editor_draft_save(
    state: tauri::State<'_, DesktopState>,
    draft: EditorDraftDto,
) -> Result<(), String> {
    let root = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || save(&root, draft))
        .await
        .map_err(|_| "editor recovery draft worker failed".to_owned())?
}

#[tauri::command]
pub async fn editor_draft_delete(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: String,
    file_ref: String,
) -> Result<(), String> {
    let root = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        delete(&root, &project_id, &resource_id, &file_ref)
    })
    .await
    .map_err(|_| "editor recovery draft worker failed".to_owned())?
}

pub(crate) fn move_file_draft(
    root: &Path,
    project_id: &str,
    resource_id: &str,
    file_ref: &str,
    renamed: &EditorFileSnapshot,
) -> Result<(), String> {
    let Some(mut draft) = load(root, project_id, resource_id, file_ref)? else {
        return Ok(());
    };
    draft.snapshot.project_id = renamed.project_id.clone();
    draft.snapshot.resource_id = renamed.resource_id.clone();
    draft.snapshot.file_ref = renamed.file_ref.clone();
    draft.snapshot.display_path = renamed.display_path.clone();
    draft.snapshot.language_hint = renamed.language_hint.clone();
    draft.snapshot.byte_size = renamed.byte_size;
    draft.snapshot.writable = renamed.writable;
    save(root, draft)?;
    delete(root, project_id, resource_id, file_ref)
}

pub(crate) fn delete_file_draft(
    root: &Path,
    project_id: &str,
    resource_id: &str,
    file_ref: &str,
) -> Result<(), String> {
    delete(root, project_id, resource_id, file_ref)
}

pub(crate) fn move_file_draft_after_directory_rename(
    root: &Path,
    project_id: &str,
    resource_id: &str,
    moved: &EditorFileMoveReceipt,
) -> Result<(), String> {
    let Some(mut draft) = load(root, project_id, resource_id, &moved.file_ref)? else {
        return Ok(());
    };
    draft.snapshot.file_ref = moved.target_file_ref.clone();
    draft.snapshot.display_path = moved.target_display_path.clone();
    draft.snapshot.language_hint = moved.language_hint.clone();
    save(root, draft)?;
    delete(root, project_id, resource_id, &moved.file_ref)
}

fn load(
    root: &Path,
    project_id: &str,
    resource_id: &str,
    file_ref: &str,
) -> Result<Option<EditorDraftDto>, String> {
    let _guard = draft_io_lock()?;
    validate_identity(project_id, resource_id, file_ref)?;
    let path = draft_path(root, project_id, resource_id, file_ref);
    if !path.exists() {
        return Ok(None);
    }

    let raw =
        fs::read(&path).map_err(|error| format!("read editor recovery draft failed: {error}"))?;
    if raw.len() > MAX_SERIALIZED_DRAFT_BYTES {
        return Err("editor recovery draft exceeds its storage limit".to_owned());
    }
    let draft = serde_json::from_slice::<EditorDraftDto>(&raw)
        .map_err(|error| format!("decode editor recovery draft failed: {error}"))?;
    validate_draft(&draft)?;
    if draft.snapshot.project_id != project_id
        || draft.snapshot.resource_id != resource_id
        || draft.snapshot.file_ref != file_ref
    {
        return Err("editor recovery draft identity does not match its storage key".to_owned());
    }

    Ok(Some(draft))
}

fn save(root: &Path, draft: EditorDraftDto) -> Result<(), String> {
    let _guard = draft_io_lock()?;
    validate_draft(&draft)?;
    let path = draft_path(
        root,
        &draft.snapshot.project_id,
        &draft.snapshot.resource_id,
        &draft.snapshot.file_ref,
    );
    let parent = path
        .parent()
        .ok_or_else(|| "editor recovery draft path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create editor recovery draft directory failed: {error}"))?;

    let encoded = serde_json::to_vec(&draft)
        .map_err(|error| format!("encode editor recovery draft failed: {error}"))?;
    if encoded.len() > MAX_SERIALIZED_DRAFT_BYTES {
        return Err("editor recovery draft exceeds its storage limit".to_owned());
    }

    let temporary = temporary_path(&path);
    fs::write(&temporary, encoded)
        .map_err(|error| format!("write editor recovery draft failed: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("replace editor recovery draft failed: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("commit editor recovery draft failed: {error}"))
}

fn delete(root: &Path, project_id: &str, resource_id: &str, file_ref: &str) -> Result<(), String> {
    let _guard = draft_io_lock()?;
    validate_identity(project_id, resource_id, file_ref)?;
    let path = draft_path(root, project_id, resource_id, file_ref);
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("delete editor recovery draft failed: {error}"))?;
    }
    Ok(())
}

fn validate_draft(draft: &EditorDraftDto) -> Result<(), String> {
    if draft.schema_version != SCHEMA_VERSION {
        return Err("editor recovery draft schema is unsupported".to_owned());
    }
    validate_identity(
        &draft.snapshot.project_id,
        &draft.snapshot.resource_id,
        &draft.snapshot.file_ref,
    )?;
    if draft.snapshot.display_path.trim().is_empty() || draft.snapshot.display_path.len() > 4096 {
        return Err("editor recovery draft display path is invalid".to_owned());
    }
    if draft.snapshot.content.len() > MAX_DRAFT_CONTENT_BYTES
        || draft.content.len() > MAX_DRAFT_CONTENT_BYTES
    {
        return Err("editor recovery draft exceeds the 2 MiB content limit".to_owned());
    }
    Ok(())
}

fn validate_identity(project_id: &str, resource_id: &str, file_ref: &str) -> Result<(), String> {
    if project_id.trim().is_empty() || project_id.len() > 512 {
        return Err("editor recovery draft project id is invalid".to_owned());
    }
    if resource_id.trim().is_empty() || resource_id.len() > 512 {
        return Err("editor recovery draft resource id is invalid".to_owned());
    }
    if file_ref.trim().is_empty() || file_ref.len() > 512 {
        return Err("editor recovery draft file ref is invalid".to_owned());
    }
    Ok(())
}

fn draft_path(root: &Path, project_id: &str, resource_id: &str, file_ref: &str) -> PathBuf {
    root.join(stable_key(project_id))
        .join(stable_key(resource_id))
        .join(format!("{}.json", stable_key(file_ref)))
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn stable_key(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn draft_io_lock() -> Result<MutexGuard<'static, ()>, String> {
    DRAFT_IO_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "editor recovery draft lock is poisoned".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        delete, load, move_file_draft, move_file_draft_after_directory_rename, save,
        EditorDraftDto, SCHEMA_VERSION,
    };
    use nucleus_server::{EditorFileMoveReceipt, EditorFileSnapshot};

    fn draft() -> EditorDraftDto {
        EditorDraftDto {
            schema_version: SCHEMA_VERSION,
            snapshot: EditorFileSnapshot {
                project_id: "project:test".to_owned(),
                resource_id: "resource:test".to_owned(),
                file_ref: "file:src/lib.rs".to_owned(),
                display_path: "src/lib.rs".to_owned(),
                content: "base".to_owned(),
                language_hint: "rust".to_owned(),
                byte_size: 4,
                writable: true,
                content_revision: "revision:base".to_owned(),
            },
            content: "changed".to_owned(),
        }
    }

    #[test]
    fn draft_round_trips_and_deletes_by_file_identity() {
        let root =
            std::env::temp_dir().join(format!("nucleus-editor-draft-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let expected = draft();

        save(&root, expected.clone()).expect("save draft");
        assert_eq!(
            load(
                &root,
                &expected.snapshot.project_id,
                &expected.snapshot.resource_id,
                &expected.snapshot.file_ref,
            )
            .expect("load draft"),
            Some(expected.clone())
        );
        delete(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &expected.snapshot.file_ref,
        )
        .expect("delete draft");
        assert_eq!(
            load(
                &root,
                &expected.snapshot.project_id,
                &expected.snapshot.resource_id,
                &expected.snapshot.file_ref,
            )
            .expect("load deleted draft"),
            None
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn storage_key_is_stable_and_never_exposes_identity_text() {
        let path = super::draft_path(
            std::path::Path::new("/drafts"),
            "project/unsafe",
            "resource:one",
            "file:src/lib.rs",
        );
        let rendered = path.to_string_lossy();

        assert!(!rendered.contains("unsafe"));
        assert!(!rendered.contains("resource:one"));
        assert!(!rendered.contains("src/lib.rs"));
        assert_eq!(
            path.extension().and_then(std::ffi::OsStr::to_str),
            Some("json")
        );
    }

    #[test]
    fn file_rename_moves_draft_identity_without_rebasing_content() {
        let root = std::env::temp_dir().join(format!(
            "nucleus-editor-draft-rename-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let expected = draft();
        let mut renamed = expected.snapshot.clone();
        renamed.file_ref = "file:src/renamed.rs".to_owned();
        renamed.display_path = "src/renamed.rs".to_owned();
        renamed.language_hint = "rust".to_owned();
        renamed.content_revision = "revision:current-disk".to_owned();
        renamed.content = "current disk".to_owned();

        save(&root, expected.clone()).expect("save draft");
        move_file_draft(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &expected.snapshot.file_ref,
            &renamed,
        )
        .expect("move draft");

        assert!(load(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &expected.snapshot.file_ref,
        )
        .expect("old draft")
        .is_none());
        let moved = load(
            &root,
            &renamed.project_id,
            &renamed.resource_id,
            &renamed.file_ref,
        )
        .expect("new draft")
        .expect("moved draft");
        assert_eq!(moved.snapshot.display_path, "src/renamed.rs");
        assert_eq!(
            moved.snapshot.content_revision,
            expected.snapshot.content_revision
        );
        assert_eq!(moved.snapshot.content, expected.snapshot.content);
        assert_eq!(moved.content, expected.content);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn folder_rename_moves_draft_identity_without_rebasing_content() {
        let root = std::env::temp_dir().join(format!(
            "nucleus-editor-draft-folder-rename-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let expected = draft();
        let moved = EditorFileMoveReceipt {
            file_ref: expected.snapshot.file_ref.clone(),
            display_path: expected.snapshot.display_path.clone(),
            target_file_ref: "file:source/lib.rs".to_owned(),
            target_display_path: "source/lib.rs".to_owned(),
            language_hint: "rust".to_owned(),
        };

        save(&root, expected.clone()).expect("save draft");
        move_file_draft_after_directory_rename(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &moved,
        )
        .expect("move draft");

        assert!(load(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &expected.snapshot.file_ref,
        )
        .expect("old draft")
        .is_none());
        let moved_draft = load(
            &root,
            &expected.snapshot.project_id,
            &expected.snapshot.resource_id,
            &moved.target_file_ref,
        )
        .expect("new draft")
        .expect("moved draft");
        assert_eq!(moved_draft.snapshot.display_path, "source/lib.rs");
        assert_eq!(moved_draft.snapshot.content, expected.snapshot.content);
        assert_eq!(moved_draft.content, expected.content);

        let _ = std::fs::remove_dir_all(root);
    }
}
