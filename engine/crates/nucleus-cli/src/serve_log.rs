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

// The service already holds the profile lock. Position zero records the
// disposition, and the rest records the last emitted service log timestamp.
pub(super) fn start(home: &Path) -> Result<()> {
    let file = File::from(open(
        home.join("serve.last-run"),
        OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?);
    require_private_file(&file)?;
    let mut prior = [0; 17];
    let prior_len = file.read_at(&mut prior, 0)?;
    log::set_logger(&ServiceLogger).map_err(|_| "the engine logger is already initialized")?;
    let mut record = [0; 17];
    record[0] = RUNNING;
    file.write_all_at(&record, 0)?;
    *RUN.lock().expect("engine log lock") = Some(file);
    log::set_max_level(log::LevelFilter::Warn);
    if prior_len > 0 {
        let end = match prior[0] {
            CLEAN => "shut down cleanly",
            FAILED => "exited with an error",
            _ => "ended unannounced",
        };
        let timestamp = i128::from_le_bytes(prior[1..].try_into()?);
        if prior_len == prior.len()
            && timestamp != 0
            && let Ok(time) = OffsetDateTime::from_unix_timestamp_nanos(timestamp)
        {
            line(format_args!(
                "Previous Nucleus engine run {end} (last log at {time})"
            ));
        } else {
            line(format_args!(
                "Previous Nucleus engine run {end} (last log time unavailable)"
            ));
        }
    }
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

pub(super) fn finish(clean: bool) -> io::Result<()> {
    if let Some(file) = RUN.lock().expect("engine log lock").take() {
        file.write_all_at(&[if clean { CLEAN } else { FAILED }], 0)?;
    }
    Ok(())
}
