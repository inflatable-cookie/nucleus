A report's proof files no longer refuse against a null recorded PR head when the
forge already shows the task branch's open PR at the reported head: the head
check reads that PR head from the forge and compares against it, and a refusal
names both the reported and the observed forge head. A report with no PR yet
keeps its proof files against the pushed branch head, checked with
`git ls-remote`, instead of refusing. Nothing already recorded is relabelled.
