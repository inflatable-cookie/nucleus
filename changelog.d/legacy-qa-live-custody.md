### Fixed

- A service roll no longer defers on finished legacy QA runs whose records still carry a dead pid, a cleanup flag or a checkout path on a volume that no longer exists. Takeover now waits only for live evidence: an unfinished run, a live QA process or a checkout still on disk.
