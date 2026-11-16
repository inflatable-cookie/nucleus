The proof-execution test fixture now stops its engine and waits for queued work before closing its store, preventing asynchronous SQLite activity after the test ends.
