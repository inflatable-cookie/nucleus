T3 calls no longer queue behind each other in Nucleus. An origin-thread lookup
that T3's live shell already answers takes no host call slot, T3 calls start
without the fixed 125 ms gap (Paseo keeps it), and the sweep reads each planner
thread's presence once per pass instead of once per project and candidate. In a
synthetic burst the median inventory slot wait fell from about 880 ms to 0.
