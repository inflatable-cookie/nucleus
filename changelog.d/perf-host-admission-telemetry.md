Service health now shows every connected host's own call queue under
`hostAdmission`, not just the legacy primary's. Each queue reports how long its
recent calls waited for a slot (per class), its total in-flight bound and the
spacing between starts, so a host call that answers quickly but waits seconds
for its turn is visible without a debugger.
