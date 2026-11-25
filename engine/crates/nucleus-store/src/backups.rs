//! Scheduled database recovery points share Spec 028's archive tiers with legacy copies.
use crate::{
    Backups, EngineStorage, SCHEMA_VERSION, StorageDirectory, StorageError, Store, StoreError,
    VerifiedBackup,
};
use flate2::{Compression, read::MultiGzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
};
use time::{OffsetDateTime, macros::format_description};
use uuid::Uuid;

const STAMP: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]-[minute]-[second]-[subsecond digits:3]Z");
const TIERS: [(&str, usize); 3] = [("hourly", 24), ("daily", 14), ("weekly", 8)];

struct Copy {
    path: PathBuf,
    at: OffsetDateTime,
    tier: &'static str,
    rust: bool,
}
fn listing(root: &StorageDirectory) -> Result<Vec<Copy>, StorageError> {
    root.verify()?;
    let mut copies = Vec::new();
    for entry in fs::read_dir(root.path())? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some((stem, kind)) = name
            .to_str()
            .and_then(|s| s.strip_suffix(".sqlite.gz"))
            .and_then(|s| s.rsplit_once('.'))
        else {
            continue;
        };
        let Some(&(tier, _)) = TIERS.iter().find(|(t, _)| *t == kind) else {
            continue;
        };
        let Some((stamp, id)) = stem.split_once("Z-") else {
            continue;
        };
        let (rust, uid) = id.strip_prefix("rust-").map_or((false, id), |s| (true, s));
        if !Uuid::parse_str(uid).is_ok_and(|u| u.hyphenated().to_string() == uid) {
            continue;
        }
        let Ok(date) = time::PrimitiveDateTime::parse(&format!("{stamp}Z"), STAMP) else {
            continue;
        };
        copies.push(Copy {
            path: entry.path(),
            at: date.assume_utc(),
            tier,
            rust,
        });
    }
    copies.sort_by_key(|c| std::cmp::Reverse(c.at));
    Ok(copies)
}

impl EngineStorage {
    /// The live store uses Barge's archives class. Isolated profiles can only address their own backups.
    ///
    /// # Errors
    /// Refuses missing, redirected or fallback archive storage.
    pub fn scheduled_directory(
        home: &Path,
        isolated: &StorageDirectory,
    ) -> Result<StorageDirectory, StorageError> {
        if crate::settings::default_home()? == home {
            StorageDirectory::barge(crate::barge::project_class("archives", "nucleus-backups")?)
        } else {
            Ok(isolated.clone())
        }
    }
}

impl EngineStorage {
    /// List verified scheduled store snapshots in their owning archive directory.
    ///
    /// # Errors
    /// Returns an error when the archives class or its directory is unavailable.
    pub fn scheduled_list(&self) -> Result<Backups, StorageError> {
        let root = Self::scheduled_directory(self.home(), self.backup())?;
        let mut status = Backups {
            root: root.path().into(),
            complete: true,
            issues: 0,
            verified: Vec::new(),
        };
        let mut seen = std::collections::BTreeSet::new();
        for c in listing(&root)? {
            if c.rust && seen.insert(c.at) {
                status.verified.push(VerifiedBackup {
                    id: c
                        .path
                        .file_name()
                        .ok_or(StorageError::Layout)?
                        .to_string_lossy()
                        .into_owned(),
                    created_at: c
                        .at
                        .format(&time::format_description::well_known::Rfc3339)
                        .map_err(|_| StorageError::Layout)?,
                });
            }
        }
        Ok(status)
    }
}

impl Store {
    /// Capture a due database backup, verify the compressed bytes and rotate the UTC tiers.
    ///
    /// # Errors
    /// A failed copy cannot replace a verified recovery point.
    pub fn scheduled_backup(
        database: &StorageDirectory,
        root: &StorageDirectory,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
            .map_err(|_| StorageError::Layout)?;
        database.verify()?;
        root.ensure()?;
        let previous = listing(root)?;
        let newest = previous.iter().find(|c| c.rust && c.tier == "hourly");
        let hourly = if let Some(last) = newest.filter(|c| now - c.at < time::Duration::hours(6)) {
            last.path.clone()
        } else {
            let path = database.path().join("engine.sqlite");
            let verified = Self::verified_copy(
                &path,
                root,
                SCHEMA_VERSION,
                ".engine-checkpoint-",
                "integrity_check",
            )?;
            let capture = || -> io::Result<tempfile::NamedTempFile> {
                let mut packed = tempfile::NamedTempFile::new_in(root.path())?;
                let mut original = verified.reopen()?;
                let mut encoder = GzEncoder::new(packed.as_file_mut(), Compression::fast());
                io::copy(&mut original, &mut encoder)?;
                encoder.finish()?.sync_all()?;
                original.rewind()?;
                if digest(original)? != digest(MultiGzDecoder::new(packed.reopen()?))? {
                    return Err(io::Error::other("compressed database digest mismatch"));
                }
                Ok(packed)
            };
            let packed = capture().map_err(StorageError::from)?;
            let stamp = now.format(STAMP).map_err(|_| StorageError::Layout)?;
            let target = root
                .path()
                .join(format!("{stamp}-rust-{}.hourly.sqlite.gz", Uuid::new_v4()));
            root.verify()?;
            packed
                .persist_noclobber(&target)
                .map_err(|e| StorageError::from(e.error))?;
            target
        };
        // Reconstruct an interrupted rotation from its published hourly file.
        let all = listing(root)?;
        let at = all
            .iter()
            .find(|c| c.path == hourly)
            .ok_or(StoreError::UpgradeBackup)?
            .at;
        for tier in ["daily", "weekly"] {
            if !all.iter().any(|c| {
                c.tier == tier
                    && if tier == "daily" {
                        c.at.date() == at.date()
                    } else {
                        c.at.to_iso_week_date().0 == at.to_iso_week_date().0
                            && c.at.iso_week() == at.iso_week()
                    }
            }) {
                let stem = hourly
                    .file_name()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.strip_suffix(".hourly.sqlite.gz"))
                    .ok_or(StorageError::Layout)?;
                let target = root.path().join(format!("{stem}.{tier}.sqlite.gz"));
                root.verify()?;
                link_copy(&hourly, &target).map_err(StorageError::from)?;
            }
        }
        let all = listing(root)?;
        for (tier, keep) in TIERS {
            for stale in all.iter().filter(|c| c.tier == tier).skip(keep) {
                root.verify()?;
                fs::remove_file(&stale.path).map_err(StorageError::from)?;
            }
        }
        File::open(root.path())
            .and_then(|d| d.sync_all())
            .map_err(StorageError::from)?;
        Ok(())
    }
}

fn digest(mut reader: impl Read) -> io::Result<[u8; 32]> {
    let mut hash = Sha256::new();
    io::copy(&mut reader, &mut hash)?;
    Ok(hash.finalize().into())
}

fn link_copy(source: &Path, target: &Path) -> io::Result<()> {
    if let Err(e) = fs::hard_link(source, target) {
        if e.kind() == io::ErrorKind::AlreadyExists {
            return Err(e);
        }
        let mut tmp = tempfile::NamedTempFile::new_in(
            target
                .parent()
                .ok_or_else(|| io::Error::other("missing archive directory"))?,
        )?;
        io::copy(&mut File::open(source)?, tmp.as_file_mut())?;
        tmp.flush()?;
        tmp.as_file().sync_all()?;
        tmp.persist_noclobber(target).map_err(|e| e.error)?;
    }
    Ok(())
}
