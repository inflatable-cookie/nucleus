A launch whose create the host may still answer now reads on the board as
"Waiting for the host to answer a launch", for a run and for the initial worker.
`run.start` for that role warns `creation_in_flight`, which only the planner or
operator board may accept, so a coordinator that was already running cannot
start a second thread beside the late one.
