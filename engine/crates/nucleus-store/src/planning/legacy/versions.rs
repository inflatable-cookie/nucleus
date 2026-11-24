use std::collections::BTreeMap;

use rusqlite::{Connection, Statement};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ImportError, has_table};
use crate::planning::decode;

pub(super) struct Reader<'a>(Option<Statement<'a>>);

impl<'a> Reader<'a> {
    pub(super) fn new(source: &'a Connection) -> Result<Self, ImportError> {
        const FULL: &str =
            "SELECT version, data, NULL, NULL, NULL FROM lead_versions WHERE leadId = ?1";
        const DELTAS: &str = "SELECT version, data, baseVersion, bodyDigest, delta
                              FROM lead_version_deltas WHERE leadId = ?1";
        let sql = match (
            has_table(source, "lead_versions")?,
            has_table(source, "lead_version_deltas")?,
        ) {
            (true, true) => format!("{FULL} UNION ALL {DELTAS} ORDER BY version DESC"),
            (true, false) => format!("{FULL} ORDER BY version DESC"),
            (false, true) => format!("{DELTAS} ORDER BY version DESC"),
            (false, false) => return Ok(Self(None)),
        };
        Ok(Self(Some(source.prepare(&sql)?)))
    }

    pub(super) fn read(&mut self, id: &str) -> Result<BTreeMap<u32, Value>, ImportError> {
        let mut output = BTreeMap::new();
        let Some(query) = &mut self.0 else {
            return Ok(output);
        };
        let mut rows = query.query([id])?;
        while let Some(row) = rows.next()? {
            let version: u32 = row.get(0)?;
            let mut snapshot: Value = decode(row, 1)?;
            let failure = || ImportError::History {
                id: id.into(),
                version,
            };
            if snapshot["version"].as_u64() != Some(u64::from(version))
                || output.contains_key(&version)
            {
                return Err(failure());
            }
            if let Some(base_version) = row.get::<_, Option<u32>>(2)? {
                let base = output
                    .get(&base_version)
                    .and_then(|value: &Value| value["body"].as_str());
                let delta: Delta = decode(row, 4)?;
                let expected: String = row.get(3)?;
                let body = base
                    .and_then(|base| delta.apply(base, version, base_version))
                    .filter(|body| digest(body) == expected)
                    .ok_or_else(failure)?;
                snapshot["body"] = Value::String(body);
            }
            let body = snapshot["body"].as_str().ok_or_else(failure)?;
            if let Some(recorded) = snapshot["digest"]
                .as_str()
                .filter(|digest| digest.starts_with("sha256:"))
                && digest(body) != recorded
            {
                return Err(failure());
            }
            output.insert(version, snapshot);
        }
        Ok(output)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    format: String,
    format_version: u32,
    base_version: u32,
    target_version: u32,
    base_digest: String,
    target_digest: String,
    base_bytes: usize,
    target_bytes: usize,
    lines: Vec<String>,
    ops: Vec<(u32, usize, usize)>,
}

impl Delta {
    fn apply(&self, base: &str, target_version: u32, base_version: u32) -> Option<String> {
        if self.format != "queue.reverse-lines"
            || self.format_version != 1
            || self.target_version != target_version
            || self.base_version != base_version
            || target_version.checked_add(1) != Some(base_version)
            || self.base_bytes != base.len()
            || self.base_digest != digest(base)
        {
            return None;
        }
        let base: Vec<_> = base.split_inclusive('\n').collect();
        let mut copied_to = 0;
        let mut output = String::new();
        for &(kind, start, count) in &self.ops {
            let end = start.checked_add(count)?;
            match kind {
                0 if start >= copied_to => {
                    for line in base.get(start..end)? {
                        output.push_str(line);
                    }
                    copied_to = end;
                }
                1 => {
                    for line in self.lines.get(start..end)? {
                        output.push_str(line);
                    }
                }
                _ => return None,
            }
            if output.len() > self.target_bytes {
                return None;
            }
        }
        (output.len() == self.target_bytes && digest(&output) == self.target_digest)
            .then_some(output)
    }
}

fn digest(body: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(body))
}
