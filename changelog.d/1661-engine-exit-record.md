- The engine now logs how its process ended: the exit code or signal, uptime
  and peak memory. The next start repeats it in the previous-run line.
- ACP clients restart a dead engine even when their launcher omits
  `--endpoint`, and their log lines show whether a failure counted as an
  outage.
- `ensure` and `serve` keep the installed ACP launcher's command lines current
  after a release roll.
