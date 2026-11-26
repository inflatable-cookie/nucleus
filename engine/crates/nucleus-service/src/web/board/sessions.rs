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
    // Written by every authenticated use. Files from before it existed read 0,
    // and the renewal time bounds last use for them.
    #[serde(default)]
    pub last_used_at: u64,
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

    /// Store a new session, reclaiming capacity first when `limit` is reached.
    /// Stale sessions expire, then the least recently used sessions are removed
    /// in the same commit. Returns how many live sessions were evicted.
    pub fn insert(
        &mut self,
        key: &[u8; 32],
        authority: Authority,
        scope: ControllerScope,
        now: u64,
        limit: usize,
    ) -> io::Result<usize> {
        self.prune(now);
        let mut entries = self.entries.clone();
        let mut evicted = 0;
        while entries.len() >= limit {
            let Some(oldest) = least_recently_used(&entries) else {
                break;
            };
            entries.remove(&oldest);
            evicted += 1;
        }
        entries.insert(
            digest(key),
            Session {
                authority,
                scope,
                expires_at: now + IDLE_MS,
                last_used_at: now,
            },
        );
        self.commit(entries, true)?;
        Ok(evicted)
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
            session.expires_at = now + IDLE_MS;
        }
        session.last_used_at = now;
        let mut entries = self.entries.clone();
        entries.insert(key, session.clone());
        // Every use is written so eviction order survives a restart. Only renewals
        // wait for the disk to sync; a crash can lose the order of the last few uses.
        self.commit(entries, refresh)?;
        Ok(Some((session, refresh)))
    }

    pub fn revoke(&mut self, now: u64) -> io::Result<usize> {
        self.prune(now);
        let revoked = self.entries.len();
        self.commit(BTreeMap::new(), true)?;
        Ok(revoked)
    }

    fn commit(&mut self, entries: BTreeMap<String, Session>, sync: bool) -> io::Result<()> {
        self.directory.verify().map_err(io::Error::other)?;
        let root = self.directory.path();
        let directory = File::open(root)?;
        let mut stage = tempfile::NamedTempFile::new_in(root)?;
        serde_json::to_writer(&mut stage, &entries)?;
        if sync {
            stage.as_file().sync_all()?;
        }
        stage
            .persist(root.join(FILE))
            .map_err(|error| error.error)?;
        self.entries = entries;
        if sync {
            directory.sync_all()?;
        }
        Ok(())
    }
}

fn digest(key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(key))
}

/// Last use is the recorded use. The renewal time bounds it for files written
/// before uses were recorded.
fn last_use(session: &Session) -> u64 {
    session
        .last_used_at
        .max(session.expires_at.saturating_sub(IDLE_MS))
}

fn least_recently_used(entries: &BTreeMap<String, Session>) -> Option<String> {
    entries
        .iter()
        .min_by_key(|(_, session)| last_use(session))
        .map(|(key, _)| key.clone())
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

#[test]
fn a_full_store_reclaims_the_least_recently_used_session_for_a_new_pairing() {
    const CAPACITY: usize = 64;
    let home = tempfile::tempdir().unwrap();
    let settings = nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    let storage = settings.configured_storage().unwrap();
    let directory = storage.database();
    directory.ensure().unwrap();
    let mut store = SessionStore::open(directory.clone(), 0).unwrap();
    let key = |n: u8| [n; 32];
    let pair = |store: &mut SessionStore, n: u8, now: u64| {
        store.insert(
            &key(n),
            Authority::Operator {
                actor: "operator".into(),
            },
            ControllerScope::default(),
            now,
            CAPACITY,
        )
    };
    // Sixty-four keys fill a store whose limit is CAPACITY.
    for n in 1..=64_u8 {
        assert_eq!(pair(&mut store, n, u64::from(n)).unwrap(), 0);
    }
    // Device 1 was paired first but used most recently, inside the same renewal window.
    assert!(store.authenticate(&key(1), 1_000).unwrap().is_some());
    assert_eq!(pair(&mut store, 65, 2_000).unwrap(), 1);
    assert!(store.authenticate(&key(1), 2_001).unwrap().is_some());
    assert!(store.authenticate(&key(2), 2_001).unwrap().is_none());
    assert!(store.authenticate(&key(65), 2_001).unwrap().is_some());
    assert_eq!(store.entries.len(), CAPACITY);
}

#[test]
fn a_full_store_of_stale_sessions_accepts_a_new_pairing_without_eviction() {
    const CAPACITY: usize = 64;
    let home = tempfile::tempdir().unwrap();
    let settings = nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    let storage = settings.configured_storage().unwrap();
    let directory = storage.database();
    directory.ensure().unwrap();
    let mut store = SessionStore::open(directory.clone(), 0).unwrap();
    // Sixty-four keys fill a store whose limit is CAPACITY.
    for n in 1..=64_u8 {
        store
            .insert(
                &[n; 32],
                Authority::Operator {
                    actor: "operator".into(),
                },
                ControllerScope::default(),
                u64::from(n),
                CAPACITY,
            )
            .unwrap();
    }
    let evicted = store
        .insert(
            &[65; 32],
            Authority::Operator {
                actor: "operator".into(),
            },
            ControllerScope::default(),
            IDLE_MS + 100,
            CAPACITY,
        )
        .unwrap();
    assert_eq!(evicted, 0);
    assert_eq!(store.entries.len(), 1);
}

#[test]
fn eviction_order_survives_a_restart() {
    const CAPACITY: usize = 64;
    let home = tempfile::tempdir().unwrap();
    let settings = nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    let storage = settings.configured_storage().unwrap();
    let directory = storage.database();
    directory.ensure().unwrap();
    let mut store = SessionStore::open(directory.clone(), 0).unwrap();
    let key = |n: u8| [n; 32];
    for n in 1..=64_u8 {
        store
            .insert(
                &key(n),
                Authority::Operator {
                    actor: "operator".into(),
                },
                ControllerScope::default(),
                u64::from(n),
                CAPACITY,
            )
            .unwrap();
    }
    // Device 1 was paired first but used most recently. The restart must keep that.
    assert!(store.authenticate(&key(1), 1_000).unwrap().is_some());
    let mut store = SessionStore::open(directory.clone(), 1_500).unwrap();
    let evicted = store
        .insert(
            &key(65),
            Authority::Operator {
                actor: "operator".into(),
            },
            ControllerScope::default(),
            2_000,
            CAPACITY,
        )
        .unwrap();
    assert_eq!(evicted, 1);
    assert!(store.authenticate(&key(1), 2_001).unwrap().is_some());
    assert!(store.authenticate(&key(2), 2_001).unwrap().is_none());
}
