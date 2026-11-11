A live agent observation that returns nothing is unobservable, the same as a
failed read, unless the host itself reports that thread archived or gone.
Run-bound output settlement keeps its participant fence in that case instead of
closing the cleanup.
