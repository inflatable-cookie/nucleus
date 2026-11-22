Closing a lane is now a deliberate, confirmed, reversible action. The lane
page, the plan rows and the drained-lane card say "Mark done" instead of
"Close lane", and marking done always asks first: the confirmation names
every project plan that lists the lane and the number of live tasks, with
Mark done and Cancel. "Close" only ever dismisses a panel or modal — the lane
modal's dismiss control is now just "Close". Finished lanes get "Reopen", in
the roadmap's Finished lanes row and on a closed lane's page, which returns
the lane to its saved plan position through the existing `lane.status`, with
no confirmation needed.
