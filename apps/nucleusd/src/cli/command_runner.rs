use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CommandRunnerCommand {
    Smoke,
    ReadOnlySpawnSmoke,
    DurableRuntimeSmoke(CliDurableRuntimeSmoke),
    DurableLiveProviderWriteSmoke(CliDurableLiveProviderWriteSmoke),
    CodexTurnStartRealWriteSmoke(CliCodexTurnStartRealWriteSmoke),
    ReadOnly(CliReadOnlyCommand),
}

impl CommandRunnerCommand {
    pub(crate) fn parse_from_iter<I>(command: String, iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        match command.as_str() {
            "read-only" => CliReadOnlyCommand::parse(iter).map(Self::ReadOnly),
            "durable-runtime-smoke" => {
                CliDurableRuntimeSmoke::parse(iter).map(Self::DurableRuntimeSmoke)
            }
            "durable-live-provider-write-smoke" => CliDurableLiveProviderWriteSmoke::parse(iter)
                .map(Self::DurableLiveProviderWriteSmoke),
            "codex-turn-start-real-write-smoke" => {
                CliCodexTurnStartRealWriteSmoke::parse(iter).map(Self::CodexTurnStartRealWriteSmoke)
            }
            _ => Self::parse_static(&command),
        }
    }

    fn parse_static(value: &str) -> Result<Self, String> {
        match value {
            "smoke" => Ok(Self::Smoke),
            "read-only-spawn-smoke" => Ok(Self::ReadOnlySpawnSmoke),
            _ => Err(format!("unsupported command-runner command: {value}")),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CliDurableRuntimeSmoke {
    pub(crate) confirm_real_write: bool,
    pub(crate) execute_provider_write: bool,
}

impl CliDurableRuntimeSmoke {
    fn parse<I>(iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        let mut config = Self::default();
        for arg in iter {
            match arg.as_str() {
                "--confirm-real-write" => config.confirm_real_write = true,
                "--execute-provider-write" => config.execute_provider_write = true,
                _ => return Err(format!("unsupported durable runtime smoke flag: {arg}")),
            }
        }
        Ok(config)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CliDurableLiveProviderWriteSmoke {
    pub(crate) confirm_real_write: bool,
    pub(crate) confirm_real_effect: bool,
    pub(crate) execute_provider_write: bool,
}

impl CliDurableLiveProviderWriteSmoke {
    fn parse<I>(iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        let mut config = Self::default();
        for arg in iter {
            match arg.as_str() {
                "--confirm-real-write" => config.confirm_real_write = true,
                "--confirm-real-effect" => config.confirm_real_effect = true,
                "--execute-provider-write" => config.execute_provider_write = true,
                _ => {
                    return Err(format!(
                        "unsupported durable live provider-write smoke flag: {arg}"
                    ));
                }
            }
        }
        Ok(config)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CliCodexTurnStartRealWriteSmoke {
    pub(crate) confirm_real_write: bool,
    pub(crate) execute_provider_write: bool,
}

impl CliCodexTurnStartRealWriteSmoke {
    fn parse<I>(iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        let mut config = Self::default();
        for arg in iter {
            match arg.as_str() {
                "--confirm-real-write" => config.confirm_real_write = true,
                "--execute-provider-write" => config.execute_provider_write = true,
                _ => return Err(format!("unsupported codex turn/start smoke flag: {arg}")),
            }
        }
        Ok(config)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CliReadOnlyCommand {
    pub(crate) working_directory: PathBuf,
    pub(crate) timeout_ms: u64,
    pub(crate) stdout_limit_bytes: usize,
    pub(crate) stderr_limit_bytes: usize,
    pub(crate) executable: String,
    pub(crate) argv: Vec<String>,
}

impl CliReadOnlyCommand {
    const DEFAULT_TIMEOUT_MS: u64 = 2_000;
    const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 16 * 1024;

    fn parse<I>(iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        let mut working_directory = std::env::current_dir()
            .map_err(|error| format!("failed to read current dir: {error}"))?;
        let mut timeout_ms = Self::DEFAULT_TIMEOUT_MS;
        let mut stdout_limit_bytes = Self::DEFAULT_OUTPUT_LIMIT_BYTES;
        let mut stderr_limit_bytes = Self::DEFAULT_OUTPUT_LIMIT_BYTES;
        let mut command_parts = Vec::new();

        while let Some(arg) = iter.next() {
            if arg == "--" {
                command_parts.extend(iter);
                break;
            }

            match arg.as_str() {
                "--cwd" => {
                    let path = iter
                        .next()
                        .ok_or_else(|| "--cwd requires a path".to_owned())?;
                    working_directory = PathBuf::from(path);
                }
                "--timeout-ms" => timeout_ms = parse_positive_u64(iter, "--timeout-ms")?,
                "--stdout-limit" => {
                    stdout_limit_bytes = parse_positive_usize(iter, "--stdout-limit")?
                }
                "--stderr-limit" => {
                    stderr_limit_bytes = parse_positive_usize(iter, "--stderr-limit")?
                }
                _ => {
                    return Err(
                        "read-only command requires flags before `--`, then executable and argv"
                            .to_owned(),
                    );
                }
            }
        }

        let executable = command_parts
            .first()
            .cloned()
            .ok_or_else(|| "read-only command requires `-- <executable> [args...]`".to_owned())?;
        let argv = command_parts.into_iter().skip(1).collect();

        Ok(Self {
            working_directory,
            timeout_ms,
            stdout_limit_bytes,
            stderr_limit_bytes,
            executable,
            argv,
        })
    }
}

fn parse_positive_u64<I>(iter: &mut I, flag: &str) -> Result<u64, String>
where
    I: Iterator<Item = String>,
{
    let value = iter
        .next()
        .ok_or_else(|| format!("{flag} requires a positive integer"))?;
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{flag} requires a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{flag} requires a positive integer"));
    }
    Ok(parsed)
}

fn parse_positive_usize<I>(iter: &mut I, flag: &str) -> Result<usize, String>
where
    I: Iterator<Item = String>,
{
    let value = iter
        .next()
        .ok_or_else(|| format!("{flag} requires a positive integer"))?;
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("{flag} requires a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{flag} requires a positive integer"));
    }
    Ok(parsed)
}
