use std::fs;
use std::path::{Path, PathBuf};

use longhorn_config::Sha256Digest;
use longhorn_core::{ScreenPoint, ScreenSize, WindowId, WindowPlacement};
use longhorn_windowing::{SavedDisplayAssociation, SavedWindowPlacement};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::PRIMARY_WINDOW_ID;

const LEGACY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
struct LegacyWindowStore {
    schema_version: u32,
    window: LegacyHostWindow,
}

#[derive(Debug, Deserialize)]
struct LegacyHostWindow {
    id: String,
    #[serde(default)]
    placement: LegacyPlacement,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyPlacement {
    #[allow(dead_code)]
    display_id: Option<String>,
    normal_bounds: Option<LegacyBounds>,
    #[serde(default)]
    maximized: bool,
}

#[derive(Debug, Deserialize)]
struct LegacyBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug)]
pub struct PreparedLegacyMigration {
    pub placement: Option<SavedWindowPlacement>,
    source_sha256: Sha256Digest,
    source_bytes: u64,
    backup_path: PathBuf,
    receipt_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMigrationReceipt<'a> {
    migration: &'static str,
    source_sha256: &'a str,
    source_bytes: u64,
    backup_path: &'a Path,
    target_path: &'a Path,
    target_sha256: String,
    canonical_display_identity_imported: bool,
}

pub fn prepare(
    target_path: &Path,
    backup_path: &Path,
    receipt_path: &Path,
) -> Result<Option<PreparedLegacyMigration>, String> {
    if target_path.exists() {
        let bytes = fs::read(target_path).map_err(|error| {
            format!(
                "read existing window placement at {} failed: {error}",
                target_path.display()
            )
        })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "existing window placement at {} is not valid JSON; source preserved: {error}",
                target_path.display()
            )
        })?;
        if value.get("domain").is_some() {
            if backup_path.exists() && !receipt_path.exists() {
                let source = fs::read(backup_path).map_err(|error| {
                    format!(
                        "read window placement migration backup at {} failed: {error}",
                        backup_path.display()
                    )
                })?;
                decode_legacy(&source, backup_path)?;
                return Ok(Some(PreparedLegacyMigration {
                    placement: None,
                    source_sha256: Sha256Digest::from_bytes(&source),
                    source_bytes: source.len() as u64,
                    backup_path: backup_path.to_path_buf(),
                    receipt_path: receipt_path.to_path_buf(),
                }));
            }
            return Ok(None);
        }
        let placement = decode_legacy(&bytes, target_path)?;
        publish_verified_backup(backup_path, &bytes)?;
        fs::remove_file(target_path).map_err(|error| {
            format!(
                "remove backed-up legacy window placement at {} failed: {error}",
                target_path.display()
            )
        })?;
        return Ok(Some(PreparedLegacyMigration {
            placement,
            source_sha256: Sha256Digest::from_bytes(&bytes),
            source_bytes: bytes.len() as u64,
            backup_path: backup_path.to_path_buf(),
            receipt_path: receipt_path.to_path_buf(),
        }));
    }

    if backup_path.exists() && !receipt_path.exists() {
        let bytes = fs::read(backup_path).map_err(|error| {
            format!(
                "read interrupted window placement migration backup at {} failed: {error}",
                backup_path.display()
            )
        })?;
        let placement = decode_legacy(&bytes, backup_path)?;
        return Ok(Some(PreparedLegacyMigration {
            placement,
            source_sha256: Sha256Digest::from_bytes(&bytes),
            source_bytes: bytes.len() as u64,
            backup_path: backup_path.to_path_buf(),
            receipt_path: receipt_path.to_path_buf(),
        }));
    }

    Ok(None)
}

impl PreparedLegacyMigration {
    pub fn complete(&self, target_path: &Path) -> Result<(), String> {
        let target = fs::read(target_path).map_err(|error| {
            format!(
                "read migrated window placement at {} failed: {error}",
                target_path.display()
            )
        })?;
        let receipt = LegacyMigrationReceipt {
            migration: "nucleus-window-placement-card097-v1",
            source_sha256: self.source_sha256.as_str(),
            source_bytes: self.source_bytes,
            backup_path: &self.backup_path,
            target_path,
            target_sha256: Sha256Digest::from_bytes(&target).as_str().to_owned(),
            canonical_display_identity_imported: false,
        };
        write_json_atomically(&self.receipt_path, &receipt)
    }
}

fn decode_legacy(bytes: &[u8], source: &Path) -> Result<Option<SavedWindowPlacement>, String> {
    let legacy: LegacyWindowStore = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "window placement at {} is neither a Longhorn envelope nor the supported legacy schema; source preserved: {error}",
            source.display()
        )
    })?;
    if legacy.schema_version != LEGACY_SCHEMA_VERSION {
        return Err(format!(
            "legacy window placement schema {} at {} is not supported; source preserved",
            legacy.schema_version,
            source.display()
        ));
    }
    if legacy.window.id != PRIMARY_WINDOW_ID {
        return Err(format!(
            "legacy window placement identifies {}, expected {PRIMARY_WINDOW_ID}; source preserved",
            legacy.window.id
        ));
    }
    let Some(bounds) = legacy.window.placement.normal_bounds else {
        return Ok(None);
    };
    if bounds.width == 0 || bounds.height == 0 {
        return Err(format!(
            "legacy window placement at {} has empty geometry; source preserved",
            source.display()
        ));
    }
    Ok(Some(SavedWindowPlacement::new(
        WindowId::new(PRIMARY_WINDOW_ID).map_err(|error| error.to_string())?,
        WindowPlacement::new(
            ScreenPoint::new(bounds.x, bounds.y),
            ScreenSize::new(bounds.width, bounds.height),
        ),
        legacy.window.placement.maximized,
        SavedDisplayAssociation::unresolved(),
    )))
}

fn publish_verified_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        let existing = fs::read(path).map_err(|error| {
            format!(
                "read legacy placement backup at {} failed: {error}",
                path.display()
            )
        })?;
        if Sha256Digest::from_bytes(&existing) != Sha256Digest::from_bytes(bytes) {
            return Err(format!(
                "legacy placement backup at {} contains different source bytes",
                path.display()
            ));
        }
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "legacy placement backup path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create legacy placement backup directory failed: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write legacy placement backup failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("publish legacy placement backup failed: {error}"))?;
    let published = fs::read(path)
        .map_err(|error| format!("verify legacy placement backup failed: {error}"))?;
    if Sha256Digest::from_bytes(&published) != Sha256Digest::from_bytes(bytes) {
        return Err("published legacy placement backup digest does not match source".to_owned());
    }
    Ok(())
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "migration receipt path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create migration receipt directory failed: {error}"))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("encode migration receipt failed: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write migration receipt failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("publish migration receipt failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::prepare;

    #[test]
    fn legacy_source_is_backed_up_before_it_is_removed() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("state/window-placement.json");
        let backup = temp.path().join("backup/legacy.json");
        let receipt = temp.path().join("backup/legacy.receipt.json");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let source = br#"{
          "schema_version": 1,
          "window": {
            "id": "window:primary",
            "placement": {
              "display_id": "display:old",
              "normal_bounds": {"x": 10, "y": 20, "width": 1280, "height": 820},
              "maximized": true
            }
          }
        }"#;
        fs::write(&target, source).unwrap();

        let prepared = prepare(&target, &backup, &receipt).unwrap().unwrap();

        assert!(!target.exists());
        assert_eq!(fs::read(&backup).unwrap(), source);
        assert!(prepared.placement.unwrap().is_maximized());
    }

    #[test]
    fn corrupt_source_is_preserved_in_place() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("window-placement.json");
        let backup = temp.path().join("legacy.json");
        let receipt = temp.path().join("legacy.receipt.json");
        fs::write(&target, b"not-json").unwrap();

        assert!(prepare(&target, &backup, &receipt).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"not-json");
        assert!(!backup.exists());
    }

    #[test]
    fn published_domain_without_receipt_resumes_receipt_completion_only() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("state/window-placement.json");
        let backup = temp.path().join("backup/legacy.json");
        let receipt = temp.path().join("backup/legacy.receipt.json");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        fs::write(
            &target,
            br#"{"domain":"nucleus.window-placement","schemaVersion":1,"value":{}}"#,
        )
        .unwrap();
        fs::write(
            &backup,
            br#"{"schema_version":1,"window":{"id":"window:primary","placement":{}}}"#,
        )
        .unwrap();

        let prepared = prepare(&target, &backup, &receipt).unwrap().unwrap();

        assert!(prepared.placement.is_none());
        assert!(target.exists());
    }
}
