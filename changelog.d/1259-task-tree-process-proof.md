Owned-process proof now judges only processes that could belong to the task. A
zombie or otherwise unreadable process with a known parent outside the task
tree no longer blocks owned-tool recovery across tasks; an unreadable fact
reads as unknown only when its parent is in the tree or itself unreadable.
The host readers drop a process whose inspection proves it exited between the
listing and its inspection, so an exited task child cannot block the proof
with an unreadable cwd or command.
