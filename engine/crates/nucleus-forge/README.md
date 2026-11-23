# GitHub merge adapter

A direct merge starts with fresh pull request identity, merge state and checks.
GitHub's direct merge endpoint compares the supplied head SHA. The adapter also
reads the configured base immediately before the PUT and verifies it again at
readback. A retarget can still occur between that last read and the PUT. The
readback reports the base mismatch and the service cannot use it for closeout.
[GitHub's direct merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

Keep the typed write outcome when the subsequent read is stale or unavailable.
If a merged REST reply omits the commit SHA, read GitHub's GraphQL merge
commit for the same PR. Its merged state, head and base must agree with REST.
[GitHub's GraphQL pull request fields](https://docs.github.com/en/graphql/reference/pulls)

GitHub's own merge state covers required conversations. A rate limit returns
its retry deadline without making another request. The pass loop waits until
that deadline before reading or sending to GitHub again.
[GitHub's rate limit contract](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
