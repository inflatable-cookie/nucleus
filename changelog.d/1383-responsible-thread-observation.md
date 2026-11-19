Project messages no longer lose a live planner to a slow read. A registered planner
whose observation runs past five seconds on a busy Paseo daemon stays first in the
shortlist, marked unverified, and receives the message through the ordinary tell
path, which queues for a busy recipient. Only a positively archived, closed or gone
thread is dropped, and a thread that answers as a different identity is never picked.

A thread never picks its own message. The sender leaves the shortlist before the
pick, so a message from the resolved thread goes to the next live candidate or
records that the sender handles it.

`project.get` shows the whole shortlist in rank order: each thread's host, ranking
reasons, last interaction, and its last observation (state, detail and when it was
taken), beside the resolved thread and the cache age. A project with no live thread
is no longer reported as having none when the planner was only slow to answer.
