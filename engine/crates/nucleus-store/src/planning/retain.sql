WITH copies AS MATERIALIZED (
    SELECT sequence, action, at_ms,
           CASE WHEN action IN ('legacy_snapshot','legacy_version','project_import','import')
                THEN coalesce(unixepoch(json_extract(snapshot,'$.updatedAt'),'subsec'),
                       CASE WHEN action IN ('legacy_snapshot','legacy_version')
                            THEN unixepoch(json_extract(snapshot,'$.createdAt'),'subsec') END)
           END AS original_seconds,
           row_number() OVER (PARTITION BY snapshot COLLATE BINARY ORDER BY sequence) AS copy
    FROM planning_history WHERE project=?1 AND kind=?2 AND id=?3 AND sequence<=?4
), versions AS (
    SELECT sequence, coalesce(round(original_seconds*1000), at_ms) AS version_ms,
           row_number() OVER (ORDER BY sequence DESC) AS recency
    FROM copies WHERE copy=1
)
DELETE FROM planning_history WHERE sequence IN (
    SELECT sequence FROM copies WHERE copy>1
    UNION ALL
    SELECT sequence FROM versions WHERE recency>20 AND version_ms<?5
)
AND (?2!='lane' OR NOT EXISTS (
    SELECT 1 FROM tasks WHERE phase NOT IN ('done','cancelled')
    AND json_extract(report_task,'$.project')=?1 AND json_extract(report_task,'$.lane')=?3
    AND json_extract(report_task,'$.delivery.artifact.version')=json_extract(planning_history.snapshot,'$.version')
    AND sequence IN (SELECT sequence FROM versions)
));
