An ordered message to one thread is now admitted once, by the per-agent order
chain that keeps its deadline and host-call fence through the native send. With
the Paseo-call bound set to one, a steer or notify no longer waited for a second
admission slot it was holding itself, and its send can no longer outlive the
deadline that fenced it. Observation identity is also fenced at invalidation, so
a read taken after a send never joins a stale pre-send read still in flight and
repopulates the cache with it.
