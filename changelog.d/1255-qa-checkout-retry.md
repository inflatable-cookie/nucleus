A milestone QA checkout that dies mid-creation is now cleaned up under the
run's ownership proof and created once more after a bounded backoff. Two
failures settle the run as a plain failure instead of leaving an uncertain
checkout retained for reconciliation.
