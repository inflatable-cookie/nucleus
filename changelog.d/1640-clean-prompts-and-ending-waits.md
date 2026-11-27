- Role prompts no longer contain stray `+` markers or indentation.
- Retries back off: failures now show their cause and offer Recheck, and retained
  checkouts are no longer re-inspected every 3 seconds. Both slow to 10 minutes.
- Finished tasks of a removed project are no longer scheduled.
- Closeout process cleanup now runs when Dispatch has never been configured.
