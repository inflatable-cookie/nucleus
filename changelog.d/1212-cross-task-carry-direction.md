The cross-task carry gate now recognizes when another task is stacked on the PR
being merged, so the PR's own commits are not misidentified as carried work.
Actual carried commits still block merge, with rebase onto the integration base
as the supported exit.
