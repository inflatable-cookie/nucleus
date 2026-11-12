A task whose lane stops returning no longer stalls the whole Nucleus sweep. Each task
quantum now gets two minutes before the sweep moves on; a quantum past that bound is
recorded on its task as an observation outage. T3 transport and timeout errors count
as a transport outage, so the next sweep re-reads the thread instead of raising
attention.
