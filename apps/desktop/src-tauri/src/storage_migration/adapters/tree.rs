use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use longhorn_config::{
    BackupAdapter, BackupAdapterCapabilities, BackupAdapterCapture, BackupAdapterCaptureMode,
    BackupAdapterCaptureRequest, BackupAdapterError, BackupAdapterId, BackupAdapterInspectRequest,
    BackupAdapterPayload, BackupAdapterRelativePath, BackupAdapterRestoreOutcome,
    BackupAdapterRestoreParticipation, BackupAdapterRestorePreview, BackupAdapterRestoreRequest,
    BackupAdapterStateEvidence, BackupSourceState, DomainDescriptor, Sha256Digest,
    StorageTransitionAdapter, StorageTransitionGuard,
};
use tempfile::tempdir_in;

use super::{failure, payload_digest};

pub(crate) struct TreeTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    root: PathBuf,
    authority: String,
    gate: Mutex<()>,
}

impl TreeTransitionAdapter {
    pub(crate) fn new(root: PathBuf, authority: &str) -> Result<Self, String> {
        Ok(Self {
            id: BackupAdapterId::new("nucleus-tree-v1").map_err(|e| e.to_string())?,
            capabilities: BackupAdapterCapabilities::new(
                BackupAdapterCaptureMode::CoordinatedBounded,
                BackupAdapterRestoreParticipation::FailureAtomic,
            ),
            root,
            authority: authority.to_owned(),
            gate: Mutex::new(()),
        })
    }
    fn entries(&self) -> Result<Option<Vec<(String, Vec<u8>)>>, BackupAdapterError> {
        collect_tree(&self.root)
    }
}

impl BackupAdapter for TreeTransitionAdapter {
    fn id(&self) -> &BackupAdapterId {
        &self.id
    }
    fn capabilities(&self) -> &BackupAdapterCapabilities {
        &self.capabilities
    }
    fn capture(
        &self,
        request: BackupAdapterCaptureRequest<'_>,
    ) -> Result<BackupAdapterCapture, BackupAdapterError> {
        let Some(entries) = self.entries()? else {
            return Ok(BackupAdapterCapture::Absent);
        };
        let total = entries.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        if total > request.limits().max_domain_bytes() {
            return Err(failure("tree-size"));
        }
        let mut payloads = vec![BackupAdapterPayload::new(
            BackupAdapterRelativePath::new("tree-root.marker").expect("static payload path"),
            Vec::new(),
        )];
        payloads.extend(entries.into_iter().map(|(path, bytes)| {
            BackupAdapterPayload::new(
                BackupAdapterRelativePath::new(format!("files/{}.bin", hex(path.as_bytes())))
                    .expect("hex payload path"),
                bytes,
            )
        }));
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads,
        })
    }
    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        if request.source_state() != BackupSourceState::Present {
            return Err(failure("tree-source-state"));
        }
        let entries = tree_payloads(&request)?;
        Ok(BackupAdapterRestorePreview::new(
            BackupAdapterStateEvidence::present(payload_digest(&entries)),
            BackupAdapterStateEvidence::from_optional(self.current_evidence(request.descriptor())?),
        ))
    }
    fn restore(
        &self,
        request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        if self.root.exists() {
            return Err(failure("tree-target-occupied"));
        }
        let entries = tree_payloads(request.inspect())?;
        if Some(&payload_digest(&entries)) != request.preview().target_evidence().sha256() {
            return Err(failure("tree-preview"));
        }
        let parent = self.root.parent().ok_or_else(|| failure("tree-parent"))?;
        fs::create_dir_all(parent).map_err(|_| failure("tree-create-parent"))?;
        let staging = tempdir_in(parent).map_err(|_| failure("tree-stage"))?;
        for (relative, bytes) in &entries {
            let path = staging.path().join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|_| failure("tree-create"))?;
            }
            fs::write(path, bytes).map_err(|_| failure("tree-write"))?;
        }
        let staging = staging.keep();
        fs::rename(&staging, &self.root).map_err(|_| failure("tree-commit"))?;
        let evidence = self
            .current_evidence(request.inspect().descriptor())?
            .ok_or_else(|| failure("tree-verify"))?;
        Ok(BackupAdapterRestoreOutcome::Verified { evidence })
    }
}

impl StorageTransitionAdapter for TreeTransitionAdapter {
    fn transition_authority(&self) -> &str {
        &self.authority
    }
    fn acquire_transition_guard(
        &self,
        _descriptor: &DomainDescriptor,
        _timeout: Duration,
    ) -> Result<Box<dyn StorageTransitionGuard + '_>, BackupAdapterError> {
        self.gate
            .lock()
            .map(|guard| Box::new(guard) as Box<dyn StorageTransitionGuard>)
            .map_err(|_| failure("tree-lock"))
    }
    fn owned_paths(&self, _descriptor: &DomainDescriptor) -> Vec<PathBuf> {
        let mut paths = vec![self.root.clone()];
        if let Ok(Some(entries)) = collect_tree_paths(&self.root) {
            paths.extend(entries);
        }
        paths
    }
    fn current_evidence(
        &self,
        _descriptor: &DomainDescriptor,
    ) -> Result<Option<Sha256Digest>, BackupAdapterError> {
        self.entries()
            .map(|entries| entries.map(|items| payload_digest(&items)))
    }
}

fn collect_tree(root: &Path) -> Result<Option<Vec<(String, Vec<u8>)>>, BackupAdapterError> {
    let Some(paths) = collect_tree_paths(root)? else {
        return Ok(None);
    };
    let mut entries = paths
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| failure("tree-confine"))?
                .to_str()
                .ok_or_else(|| failure("tree-path"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let bytes = fs::read(&path).map_err(|_| failure("tree-read"))?;
            Ok((relative, bytes))
        })
        .collect::<Result<Vec<_>, BackupAdapterError>>()?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(Some(entries))
}

fn collect_tree_paths(root: &Path) -> Result<Option<Vec<PathBuf>>, BackupAdapterError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("tree-read")),
    };
    if !metadata.file_type().is_dir() {
        return Err(failure("tree-root"));
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries = fs::read_dir(directory)
            .map_err(|_| failure("tree-read"))?
            .map(|entry| {
                entry
                    .map(|entry| entry.path())
                    .map_err(|_| failure("tree-read"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        for path in entries.into_iter().rev() {
            let metadata = fs::symlink_metadata(&path).map_err(|_| failure("tree-read"))?;
            if metadata.file_type().is_dir() {
                stack.push(path);
            } else if metadata.file_type().is_file() {
                files.push(path);
            } else {
                return Err(failure("tree-special-file"));
            }
        }
    }
    files.sort();
    Ok(Some(files))
}

fn tree_payloads(
    request: &BackupAdapterInspectRequest<'_>,
) -> Result<Vec<(String, Vec<u8>)>, BackupAdapterError> {
    let mut marker = false;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for payload in request.payloads() {
        let path = payload.path().as_str();
        if path.ends_with("/tree-root.marker") {
            marker = true;
            continue;
        }
        let encoded = path
            .rsplit('/')
            .next()
            .and_then(|name| name.strip_suffix(".bin"))
            .ok_or_else(|| failure("tree-payload"))?;
        let relative = String::from_utf8(unhex(encoded)?).map_err(|_| failure("tree-path"))?;
        validate_relative_tree_path(&relative)?;
        if !seen.insert(relative.clone()) {
            return Err(failure("tree-duplicate"));
        }
        entries.push((relative, payload.bytes().to_vec()));
    }
    if !marker {
        return Err(failure("tree-marker"));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

fn validate_relative_tree_path(path: &str) -> Result<(), BackupAdapterError> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(failure("tree-confine"));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn unhex(value: &str) -> Result<Vec<u8>, BackupAdapterError> {
    if value.len() % 2 != 0 {
        return Err(failure("tree-path"));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_value(pair[0]).ok_or_else(|| failure("tree-path"))?;
            let low = hex_value(pair[1]).ok_or_else(|| failure("tree-path"))?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}
