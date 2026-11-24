use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    time::Duration,
};

use nucleus_core::Authority;
use nucleus_store::StorageDirectory;
use rustix::{
    fs::{FileType, Mode, OFlags, fstat, open},
    process::geteuid,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ControllerScope;

pub(super) const IDLE: Duration = Duration::from_hours(30 * 24);
const IDLE_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const REFRESH_MS: u64 = 24 * 60 * 60 * 1_000;
const LIMIT: u64 = 128 * 1024;
const FILE: &str = "web-sessions.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Session {
    pub authority: Authority,
    pub scope: ControllerScope,
    pub expires_at: u64,
}

pub(super) struct SessionStore {
    directory: StorageDirectory,
    entries: BTreeMap<String, Session>,
}

impl SessionStore {
    pub fn open(directory: StorageDirectory, now: u64) -> io::Result<Self> {
        directory.verify().map_err(io::Error::other)?;
        let entries = match open(
            directory.path().join(FILE),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let metadata = fstat(&fd)?;
                if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
                    || metadata.st_uid != geteuid().as_raw()
                    || Mode::from_raw_mode(metadata.st_mode).intersects(Mode::RWXG | Mode::RWXO)
                {
                    return Err(io::Error::other(
                        "the board session file must be owner-only",
                    ));
                }
                let mut bytes = Vec::new();
                File::from(fd).take(LIMIT + 1).read_to_end(&mut bytes)?;
                if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > LIMIT {
                    return Err(io::Error::other(
                        "the board session file exceeds its size limit",
                    ));
                }
                serde_json::from_slice::<BTreeMap<String, Session>>(&bytes)?
            }
            Err(rustix::io::Errno::NOENT) => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        let mut store = Self { directory, entries };
        store.prune(now);
        Ok(store)
    }

    fn prune(&mut self, now: u64) {
        self.entries.retain(|_, session| session.expires_at > now);
    }

    pub fn insert(
        &mut self,
        key: &[u8; 32],
        authority: Authority,
        scope: ControllerScope,
        now: u64,
        limit: usize,
    ) -> io::Result<()> {
        self.prune(now);
        if self.entries.len() >= limit {
            return Err(io::Error::other("the board session limit was reached"));
        }
        let mut entries = self.entries.clone();
        entries.insert(
            digest(key),
            Session {
                authority,
                scope,
                expires_at: now + IDLE_MS,
            },
        );
        self.commit(entries)
    }

    pub fn authenticate(
        &mut self,
        key: &[u8; 32],
        now: u64,
    ) -> io::Result<Option<(Session, bool)>> {
        let key = digest(key);
        let Some(mut session) = self
            .entries
            .get(&key)
            .filter(|session| session.expires_at > now)
            .cloned()
        else {
            return Ok(None);
        };
        let refresh = session.expires_at <= now + IDLE_MS - REFRESH_MS;
        if refresh {
            self.prune(now);
            let mut entries = self.entries.clone();
            session.expires_at = now + IDLE_MS;
            entries.insert(key, session.clone());
            self.commit(entries)?;
        }
        Ok(Some((session, refresh)))
    }

    pub fn revoke(&mut self, now: u64) -> io::Result<usize> {
        self.prune(now);
        let revoked = self.entries.len();
        self.commit(BTreeMap::new())?;
        Ok(revoked)
    }

    fn commit(&mut self, entries: BTreeMap<String, Session>) -> io::Result<()> {
        self.directory.verify().map_err(io::Error::other)?;
        let root = self.directory.path();
        let directory = File::open(root)?;
        let mut stage = tempfile::NamedTempFile::new_in(root)?;
        serde_json::to_writer(&mut stage, &entries)?;
        stage.as_file().sync_all()?;
        stage
            .persist(root.join(FILE))
            .map_err(|error| error.error)?;
        self.entries = entries;
        directory.sync_all()
    }
}

fn digest(key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(key))
}

#[test]
fn session_slides_after_one_day_of_activity_and_expires_after_thirty_days_idle() {
    let home = tempfile::tempdir().unwrap();
    let settings = nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    let storage = settings.configured_storage().unwrap();
    let directory = storage.database();
    directory.ensure().unwrap();
    let mut store = SessionStore::open(directory.clone(), 0).unwrap();
    let key = [7; 32];
    let authority = Authority::Operator {
        actor: "operator".into(),
    };
    store
        .insert(&key, authority, ControllerScope::default(), 0, 64)
        .unwrap();
    assert!(!store.authenticate(&key, REFRESH_MS - 1).unwrap().unwrap().1);
    assert!(store.authenticate(&key, REFRESH_MS).unwrap().unwrap().1);
    let expires = IDLE_MS + REFRESH_MS;
    let store = SessionStore::open(directory.clone(), expires - 1).unwrap();
    assert_eq!(store.entries[&digest(&key)].expires_at, expires);
    assert!(
        SessionStore::open(directory.clone(), expires)
            .unwrap()
            .entries
            .is_empty()
    );
}
