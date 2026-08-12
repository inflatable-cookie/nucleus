//! Notification ledger persistence: empty ledger construction, replay from
//! disk, atomic snapshot writes, and shared helpers.
//!
//! Split from the notifications god file; behavior unchanged.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use longhorn_core::NotificationAuthorityId;
use longhorn_notifications::{
    NotificationAuthorityEpoch, NotificationLedger, NotificationLedgerLimits,
    NotificationMutationCommand, NotificationMutationResult, NotificationReadStateProjection,
    NotificationSnapshot,
};

use super::{PersistedLedger, RETAINED_LIMIT, RETAINED_WEIGHT_LIMIT, SNAPSHOT_LIMIT, id};

pub(super) fn empty_ledger() -> Result<NotificationLedger, String> {
    Ok(NotificationLedger::new(
        id::<NotificationAuthorityId>(super::AUTHORITY_ID)?,
        NotificationAuthorityEpoch::new(1).map_err(|error| error.to_string())?,
        NotificationLedgerLimits::new(RETAINED_LIMIT, RETAINED_WEIGHT_LIMIT)
            .map_err(|error| error.to_string())?,
    ))
}

pub(super) fn restore(
    ledger: &mut NotificationLedger,
    persisted: PersistedLedger,
) -> Result<(), String> {
    if persisted.schema_version != 1 {
        return Err(format!(
            "unsupported notification ledger schema {}",
            persisted.schema_version
        ));
    }
    for (index, record) in persisted.records_newest_first.into_iter().rev().enumerate() {
        let snapshot = NotificationSnapshot::from_ledger(ledger, 0, SNAPSHOT_LIMIT)
            .map_err(|error| error.to_string())?;
        let result = ledger
            .execute_protocol_mutation(NotificationMutationCommand::Add {
                request_id: id(&format!("request:nucleus-notification:restore:{index}:add"))?,
                protocol_version: super::NotificationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                expected_ledger_revision: snapshot.ledger_revision,
                notification_id: record.notification_id.clone(),
                draft: record.draft,
            })
            .map_err(|error| error.to_string())?;
        if !matches!(result, NotificationMutationResult::Committed { .. }) {
            return Err("persisted notification replay was rejected".to_owned());
        }
        if record.read_state == NotificationReadStateProjection::Seen {
            let snapshot = NotificationSnapshot::from_ledger(ledger, 0, SNAPSHOT_LIMIT)
                .map_err(|error| error.to_string())?;
            let result = ledger
                .execute_protocol_mutation(NotificationMutationCommand::MarkSeen {
                    request_id: id(&format!(
                        "request:nucleus-notification:restore:{index}:seen"
                    ))?,
                    protocol_version: super::NotificationProtocolVersion::CURRENT,
                    authority: snapshot.authority,
                    expected_ledger_revision: snapshot.ledger_revision,
                    notification_id: record.notification_id,
                })
                .map_err(|error| error.to_string())?;
            if !matches!(result, NotificationMutationResult::Committed { .. }) {
                return Err("persisted notification read state was rejected".to_owned());
            }
        }
    }
    Ok(())
}

pub(super) fn persist_committed(
    path: &Path,
    result: &NotificationMutationResult,
) -> Result<(), String> {
    let NotificationMutationResult::Committed { snapshot, .. } = result else {
        return Ok(());
    };
    let persisted = PersistedLedger {
        schema_version: 1,
        records_newest_first: snapshot
            .page
            .records
            .iter()
            .map(|record| super::PersistedRecord {
                notification_id: record.notification_id.clone(),
                draft: record.draft.clone(),
                read_state: record.read_state,
            })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub(super) fn read_persisted(path: &Path) -> Result<PersistedLedger, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

pub(super) fn presentation_time() -> Option<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(millis).ok()
}
