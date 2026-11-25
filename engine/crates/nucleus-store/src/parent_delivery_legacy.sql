WITH attempts AS (
    SELECT e.sequence, t.id AS task_id, e.kind,
        json_extract(e.detail, '$.version') AS version,
        json_extract(e.detail, '$.command') AS command,
        json_extract(e.detail, '$.session') AS session,
        json_extract(e.detail, '$.prompt') AS prompt,
        e.kind = 'acp_row_refresh_intent' AS refresh
    FROM tasks AS t JOIN events AS e ON e.task_id = t.id
    WHERE t.phase NOT IN ('done', 'cancelled')
      AND e.kind IN ('native_turn_intent', 'native_turn_replay', 'acp_row_refresh_intent')
      AND json_valid(e.detail) AND json_type(e.detail, '$.command') = 'text'
      AND (json_extract(e.detail, '$.version') = t.version
           OR (json_extract(e.detail, '$.version') < t.version
               AND instr(json_extract(e.detail, '$.command'), '-hold-acp-child-') > 0))
), proofs AS MATERIALIZED (
    SELECT a.*, (
        SELECT p.sequence FROM events AS p
        WHERE p.task_id = a.task_id AND p.kind IN ('native_turn_failed', 'native_turn_observed', 'native_turn_not_sent')
          AND json_valid(p.detail) AND json_extract(p.detail, '$.command') = a.command
          AND json_extract(p.detail, '$.version') = a.version
          AND ((p.kind = 'native_turn_failed' AND EXISTS (
                   SELECT 1 FROM attempts AS origin
                   WHERE origin.task_id = a.task_id AND origin.version = a.version
                     AND origin.command = a.command AND origin.sequence <= a.sequence
                     AND origin.kind IN ('native_turn_intent', 'acp_row_refresh_intent')
                     AND (origin.session = a.session OR instr(a.session, origin.session || '/') = 1)
                     AND (origin.session = json_extract(p.detail, '$.session')
                          OR instr(json_extract(p.detail, '$.session'), origin.session || '/') = 1)))
               OR (p.kind = 'native_turn_observed' AND
                   (json_extract(p.detail, '$.session') = a.session
                    OR instr(a.session, json_extract(p.detail, '$.session') || '/') = 1))
               OR (p.kind = 'native_turn_not_sent' AND p.sequence > a.sequence AND
                   (json_extract(p.detail, '$.attempt') = a.sequence
                    OR (json_type(p.detail, '$.attempt') IS NULL
                        AND json_extract(p.detail, '$.session') = a.session))))
        ORDER BY p.kind <> 'native_turn_not_sent' DESC, p.sequence DESC LIMIT 1
    ) AS proof FROM attempts AS a
), ranked AS (
    SELECT a.*,
        first_value(a.prompt) OVER (PARTITION BY a.task_id, a.command ORDER BY a.sequence) AS frozen_prompt,
        row_number() OVER (occurrence ORDER BY a.sequence DESC) AS newest,
        sum(a.proof IS NULL) OVER occurrence AS unresolved,
        max(CASE WHEN p.kind <> 'native_turn_not_sent' THEN a.proof END) OVER occurrence AS definitive
    FROM proofs AS a LEFT JOIN events AS p ON p.sequence = a.proof
    WINDOW occurrence AS (PARTITION BY a.task_id, a.version, a.command)
)
INSERT INTO parent_deliveries
    (task_id, version, command, refresh, runtime, legacy_prompt, due_ms, result)
SELECT a.task_id, a.version, a.command, a.refresh, a.session, a.frozen_prompt, 0,
    CASE WHEN a.unresolved > 0 THEN 'pending' ELSE
        CASE p.kind WHEN 'native_turn_failed' THEN 'failed'
                    WHEN 'native_turn_observed' THEN 'accepted'
                    ELSE 'refused' END
    END
FROM ranked AS a LEFT JOIN events AS p ON p.sequence = a.definitive
WHERE a.newest = 1 ORDER BY a.sequence;

INSERT INTO parent_deliveries (task_id, version, command, refresh, due_ms, result)
SELECT t.id, t.version, '', 0, 0, 'held'
FROM tasks AS t
WHERE t.phase NOT IN ('done', 'cancelled') AND EXISTS (
    SELECT 1 FROM events AS e
    WHERE e.task_id = t.id AND e.kind = 'host_observation_blocked' AND json_valid(e.detail)
      AND json_extract(e.detail, '$.version') = t.version
      AND json_extract(e.detail, '$.deliveryPending') = 1
      AND NOT EXISTS (
        SELECT 1 FROM parent_deliveries AS d WHERE d.task_id = t.id AND d.version = t.version
          AND (d.runtime = json_extract(e.detail, '$.session')
               OR instr(json_extract(e.detail, '$.session'), d.runtime || '/') = 1
               OR instr(d.runtime, json_extract(e.detail, '$.session') || '/') = 1)
      )
);
