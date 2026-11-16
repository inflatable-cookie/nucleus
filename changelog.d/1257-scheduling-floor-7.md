The scheduling sweep keeps only its sweep: the hourly and daily store chores and
the periodic owner and lane passes now run in their own owner, and one host's
audit steps in another, so a host step that fails is recorded instead of being
dropped with its promise. The dead capacity-blocked rotation is gone. Task wakes
let the git-transient plan alone decide the uncertain-delivery skip, and a wake
that fails while the engine runs is recorded on the task rather than lost. The
lifecycle pass reads the recorded callback-reminder stops and the blocked review
wait from the owners that wrote them instead of rebuilding their sentences.
