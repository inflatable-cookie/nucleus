The engine and the service runtime now split along their named seams: host-adapter
routing, lane-key parse and profile catalogs each have an owner under `core/host`
and `core/review`; Paseo session and plugin presence, store backup and compaction
health, and origin-thread review-entry wrapping each have an owner under
`service/` and `core/review`. QueueRuntime and Engine keep their public method
names as one-line delegates. Behaviour is unchanged except laneHost reads
`taskOrNull` instead of throwing and swallowing, inspectReviewEntry origin wrapping
has one owner, and T3 identity uses `hostKindOf` plus the empty `t3code:` sentinel.
