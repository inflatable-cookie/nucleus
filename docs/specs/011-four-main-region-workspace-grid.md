# 011 Four Main Region Workspace Grid

Status: active
Owner: Tom
Updated: 2026-07-14

## Intent

Add a bottom-right workspace region and remove panel-kind placement friction.
Keep the layout semantic and fixed rather than introducing arbitrary split
trees.

## Shape

- left remains the project/activity region
- the main workspace is centerTop, centerBottom, rightTop, and rightBottom
- every workspace tab can move to any main region
- existing persisted `right` panels migrate to `rightTop`
- `rightBottom` starts empty and appears while dragging an eligible tab
- center and right columns keep independent vertical split ratios

## Non-goals

- arbitrary nested split trees
- moving project/activity navigation into the main workspace
- multiple native windows
- panel presets or saved layouts

## Checkpoint

Stop after schema migration, four-region rendering, drag/drop validation, and
operator layout review.
