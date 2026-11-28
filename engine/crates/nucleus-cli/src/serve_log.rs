use std::{
    fmt,
    fs::File,
    io::{self, Write},
    os::unix::fs::FileExt,
    path::Path,
    sync::Mutex,
};

use rustix::fs::{Mode, OFlags, open};
use time::OffsetDateTime;

use crate::{Result, require_private_file};

static RUN: Mutex<Option<File>> = Mutex::new(None);
const RUNNING: u8 = b'R';
const CLEAN: u8 = b'C';
const FAILED: u8 = b'F';
// A run record is the disposition, the last log time and the engine's process
// ID. Its supervisor appends the log time again, followed by the exit cause.
const TIMED: usize = 17;
const OWNED: usize = TIMED + 4;
const CAUSED: usize = OWNED + 16;

struct ServiceLogger;

impl log::Log for ServiceLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == "nucleus::serve"
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            line(*record.args());
        }
    }

    fn flush(&self) {}
}

fn open_record(home: &Path, flags: OFlags) -> Result<File> {
    let file = File::from(open(
        home.join("serve.last-run"),
        OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC | flags,
        Mode::RUSR | Mode::WUSR,
    )?);
    require_private_file(&file)?;
    Ok(file)
}

// The caller holds the profile lock.
pub(super) fn start(home: &Path) -> Result<()> {
    let file = open_record(home, OFlags::CREATE)?;
    let mut prior = [0; CAUSED + 128];
    let prior_len = file.read_at(&mut prior, 0)?;
    log::set_logger(&ServiceLogger).map_err(|_| "the engine logger is already initialized")?;
    let mut record = [0; OWNED];
    record[0] = RUNNING;
    record[TIMED..].copy_from_slice(&std::process::id().to_le_bytes());
    file.write_all_at(&record, 0)?;
    file.set_len(u64::try_from(OWNED)?)?;
    *RUN.lock().expect("engine log lock") = Some(file);
    log::set_max_level(log::LevelFilter::Warn);
    if prior_len > 0 {
        let end = match prior[0] {
            CLEAN => "shut down cleanly",
            FAILED => "exited with an error",
            _ => "ended unannounced",
        };
        let timestamp = i128::from_le_bytes(prior[1..TIMED].try_into()?);
        // An older release rewrites the log time and leaves a stale cause behind.
        let cause = if prior_len > CAUSED && prior[OWNED..CAUSED] == prior[1..TIMED] {
            format!(": {}", String::from_utf8_lossy(&prior[CAUSED..prior_len]))
        } else {
            String::new()
        };
        if prior_len >= TIMED
            && timestamp != 0
            && let Ok(time) = OffsetDateTime::from_unix_timestamp_nanos(timestamp)
        {
            line(format_args!(
                "Previous Nucleus engine run {end} (last log at {time}){cause}"
            ));
        } else {
            line(format_args!(
                "Previous Nucleus engine run {end} (last log time unavailable){cause}"
            ));
        }
    }
    line(format_args!("Nucleus engine initializing"));
    Ok(())
}

pub(super) fn line(message: fmt::Arguments<'_>) {
    write_line(io::stderr(), message);
}

pub(super) fn listening(address: std::net::SocketAddr) {
    write_line(
        io::stdout(),
        format_args!("Nucleus engine listening on http://{address}"),
    );
}

fn write_line(mut output: impl Write, message: fmt::Arguments<'_>) {
    let run = RUN.lock().expect("engine log lock");
    let now = OffsetDateTime::now_utc();
    let _ = output.write_all(format!("{now} {message}\n").as_bytes());
    if let Some(file) = run.as_ref()
        && let Err(error) = file.write_all_at(&now.unix_timestamp_nanos().to_le_bytes(), 1)
    {
        let _ = writeln!(
            io::stderr(),
            "{now} could not record the last engine log time: {error}"
        );
    }
}

/// Add the exit cause to the run record, if `process` is the run it holds. A
/// launch refused before it started a run leaves the record alone.
pub(super) fn record_exit(home: &Path, process: u32, cause: &str) -> Result<()> {
    let file = open_record(home, OFlags::empty())?;
    let mut record = [0; OWNED];
    if file.read_at(&mut record, 0)? == OWNED && record[TIMED..] == process.to_le_bytes() {
        let entry = [&record[1..TIMED], cause.as_bytes()].concat();
        file.write_all_at(&entry, u64::try_from(OWNED)?)?;
    }
    Ok(())
}

pub(super) fn finish(clean: bool) -> io::Result<()> {
    if let Some(file) = RUN.lock().expect("engine log lock").take() {
        file.write_all_at(&[if clean { CLEAN } else { FAILED }], 0)?;
    }
    Ok(())
}
