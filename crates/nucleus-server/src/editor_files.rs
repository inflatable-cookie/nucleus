use std::fs;
use std::io::Write;
use std::path::Path;

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_file_policy::{
    admitted_path, admitted_project_walk, MAX_ADMITTED_PROJECT_FILES, MAX_PROJECT_TEXT_FILE_BYTES,
};
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

const MAX_EDITOR_FILE_BYTES: u64 = MAX_PROJECT_TEXT_FILE_BYTES;
const MAX_DISCOVERED_FILES: usize = MAX_ADMITTED_PROJECT_FILES;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileEntry {
    pub file_ref: String,
    pub display_path: String,
    pub language_hint: String,
    pub byte_size: u64,
    pub writable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileSnapshot {
    pub project_id: String,
    pub resource_id: String,
    pub file_ref: String,
    pub display_path: String,
    pub content: String,
    pub language_hint: String,
    pub byte_size: u64,
    pub writable: bool,
    pub content_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileSaveRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub file_ref: String,
    pub expected_content_revision: String,
    pub content: String,
}

pub fn list_editor_files<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
) -> Result<Vec<EditorFileEntry>, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    discover(&target.root)
}

pub fn read_editor_file<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    file_ref: &str,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    let entry = resolve_entry(&target.root, file_ref)?;
    snapshot(project_id, &target.resource_id, &target.root, &entry)
}

pub fn save_editor_file<B>(
    state: &ServerStateService<B>,
    request: &EditorFileSaveRequest,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    if request.content.len() as u64 > MAX_EDITOR_FILE_BYTES {
        return Err("editor file exceeds the 2 MiB save limit".to_owned());
    }
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let root = target.root;
    let entry = resolve_entry(&root, &request.file_ref)?;
    if !entry.writable {
        return Err("editor file is read-only".to_owned());
    }
    let current = snapshot(&request.project_id, &target.resource_id, &root, &entry)?;
    if current.content_revision != request.expected_content_revision {
        return Err("editor file conflict: content changed since it was opened".to_owned());
    }

    let path = admitted_path(&root, &entry.display_path)?;
    let permissions = fs::metadata(&path)
        .map_err(|error| format!("editor file metadata failed: {error}"))?
        .permissions();
    let parent = path
        .parent()
        .ok_or_else(|| "editor file has no parent directory".to_owned())?;
    let mut replacement = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("editor save staging failed: {error}"))?;
    replacement
        .write_all(request.content.as_bytes())
        .and_then(|_| replacement.as_file().sync_all())
        .map_err(|error| format!("editor save staging failed: {error}"))?;
    replacement
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| format!("editor save permission preservation failed: {error}"))?;
    replacement
        .persist(&path)
        .map_err(|error| format!("editor save replacement failed: {}", error.error))?;

    snapshot(&request.project_id, &target.resource_id, &root, &entry)
}

fn discover(root: &Path) -> Result<Vec<EditorFileEntry>, String> {
    let mut entries = Vec::new();
    let walker = admitted_project_walk(root);
    for result in walker {
        let entry = result.map_err(|error| format!("editor file discovery failed: {error}"))?;
        let file_type = entry.file_type();
        if !file_type.is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("editor file metadata failed: {error}"))?;
        if metadata.len() > MAX_EDITOR_FILE_BYTES || !is_text_file(entry.path())? {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "editor file escaped the project root".to_owned())?;
        let display_path = relative.to_string_lossy().replace('\\', "/");
        entries.push(EditorFileEntry {
            file_ref: file_ref(&display_path),
            language_hint: language_hint(&display_path).to_owned(),
            display_path,
            byte_size: metadata.len(),
            writable: !metadata.permissions().readonly(),
        });
        if entries.len() >= MAX_DISCOVERED_FILES {
            break;
        }
    }
    entries.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    Ok(entries)
}

fn resolve_entry(root: &Path, expected_ref: &str) -> Result<EditorFileEntry, String> {
    cached_discover(root)?
        .into_iter()
        .find(|entry| entry.file_ref == expected_ref)
        .ok_or_else(|| "editor file ref was not found in the admitted project files".to_owned())
}

/// Short-lived discovery cache: every open and save used to re-walk and
/// re-probe the whole project. Entries expire quickly so external file
/// changes still appear; saves go through `snapshot` re-reads regardless.
fn cached_discover(root: &Path) -> Result<Vec<EditorFileEntry>, String> {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    const DISCOVERY_TTL: Duration = Duration::from_secs(2);
    static CACHE: Mutex<Option<HashMap<PathBuf, (Instant, Vec<EditorFileEntry>)>>> =
        Mutex::new(None);

    let key = root.to_path_buf();
    let mut guard = CACHE
        .lock()
        .map_err(|_| "editor discovery cache lock poisoned".to_owned())?;
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((at, entries)) = cache.get(&key) {
        if at.elapsed() < DISCOVERY_TTL {
            return Ok(entries.clone());
        }
    }
    let entries = discover(root)?;
    cache.insert(key, (Instant::now(), entries.clone()));
    Ok(entries)
}

fn snapshot(
    project_id: &str,
    resource_id: &str,
    root: &Path,
    entry: &EditorFileEntry,
) -> Result<EditorFileSnapshot, String> {
    let path = admitted_path(root, &entry.display_path)?;
    let bytes = fs::read(&path).map_err(|error| format!("editor file read failed: {error}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_BYTES || bytes.contains(&0) {
        return Err("editor file is no longer an admitted text file".to_owned());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "editor file is not valid UTF-8 text".to_owned())?;
    Ok(EditorFileSnapshot {
        project_id: project_id.to_owned(),
        resource_id: resource_id.to_owned(),
        file_ref: entry.file_ref.clone(),
        display_path: entry.display_path.clone(),
        language_hint: entry.language_hint.clone(),
        byte_size: content.len() as u64,
        writable: entry.writable,
        content_revision: format!("content:{}", blake3::hash(content.as_bytes()).to_hex()),
        content,
    })
}

/// Probe text-ness from a bounded prefix instead of reading whole files:
/// discovery runs this for every candidate, so full reads made listing
/// O(total repo bytes).
fn is_text_file(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    const PROBE_BYTES: usize = 8 * 1024;
    let mut file =
        fs::File::open(path).map_err(|error| format!("editor file probe failed: {error}"))?;
    let mut buffer = vec![0_u8; PROBE_BYTES];
    let mut filled = 0;
    while filled < PROBE_BYTES {
        let read = file
            .read(&mut buffer[filled..])
            .map_err(|error| format!("editor file probe failed: {error}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    let probe = &buffer[..filled];
    if probe.contains(&0) {
        return Ok(false);
    }
    // A multi-byte UTF-8 sequence may be cut at the probe boundary; only the
    // final three bytes can be a legitimate partial sequence.
    match std::str::from_utf8(probe) {
        Ok(_) => Ok(true),
        Err(error) => Ok(filled == PROBE_BYTES && probe.len() - error.valid_up_to() < 4),
    }
}

fn file_ref(display_path: &str) -> String {
    format!(
        "editor-file:{}",
        blake3::hash(display_path.as_bytes()).to_hex()
    )
}

fn language_hint(path: &str) -> &str {
    match Path::new(path).extension().and_then(|value| value.to_str()) {
        Some("rs") => "rust",
        Some("js" | "mjs" | "cjs") => "javascript",
        Some("ts" | "mts" | "cts") => "typescript",
        Some("json") => "json",
        Some("html" | "svelte") => "html",
        Some("css" | "scss" | "less") => "css",
        Some("md" | "mdx") => "markdown",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{seed_local_project, LocalProjectSeed};
    use nucleus_core::{PersistenceRecordId, RevisionId};
    use nucleus_local_store::{RevisionExpectation, SqliteBackend};
    use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload};

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
        resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
        record.revision_id = RevisionId("rev:editor-test".to_owned());
        record.payload = nucleus_local_store::LocalStoreRecordPayload {
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
        fs::write(dir.path().join("demo.rs"), "fn main() {}\n").expect("write");
        fs::write(dir.path().join("binary.bin"), b"a\0b").expect("binary");
        fs::create_dir(dir.path().join("target")).expect("target");
        fs::write(dir.path().join("target/hidden.rs"), "hidden").expect("hidden");
        fs::write(dir.path().join(".gitignore"), "ignored.rs\n").expect("ignore file");
        fs::write(dir.path().join("ignored.rs"), "ignored").expect("ignored");
        let oversized = fs::File::create(dir.path().join("oversized.txt")).expect("oversized");
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
        let opened =
            read_editor_file(&state, "project:nucleus-local", None, &demo.file_ref).expect("read");
        let saved = save_editor_file(
            &state,
            &EditorFileSaveRequest {
                project_id: opened.project_id.clone(),
                resource_id: Some(opened.resource_id.clone()),
                file_ref: opened.file_ref.clone(),
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
                expected_content_revision: opened.content_revision,
                content: "stale".to_owned(),
            }
        )
        .expect_err("conflict")
        .contains("conflict"));
    }

    #[test]
    fn explicit_resource_target_keeps_editor_reads_in_the_selected_root() {
        let (first, state) = fixture();
        let second = tempfile::tempdir().expect("second resource");
        fs::write(first.path().join("first.txt"), "first").expect("first file");
        fs::write(second.path().join("second.txt"), "second").expect("second file");
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
        record.payload = nucleus_local_store::LocalStoreRecordPayload {
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
}
