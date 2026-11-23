Starting a reviewer explicitly now moves the task into review. Returning a
parked task to review also lets Nucleus publish and apply the current
reviewer's saved verdict when it still matches the PR head.
Discarding a verdict while starting a replacement reviewer also prevents an
in-flight verification from applying it.
