Owned-process proof now judges only processes that could belong to the task. A
zombie or otherwise unreadable process with a known parent outside the task
tree no longer blocks owned-tool recovery across tasks; an unreadable fact
reads as unknown only when its parent is in the tree or itself unreadable.
