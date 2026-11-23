A Spec 068 acceptance test now crashes a whole board in one step and checks that
every task recovers with no owner, planner or operator command. Fifteen of its
seventeen lifecycle states recover. The four gaps it found are recorded as
pending subtests in the test and listed in Spec 068.
