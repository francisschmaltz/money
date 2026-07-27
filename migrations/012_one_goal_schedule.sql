BEGIN;

CREATE TEMP TABLE duplicate_goal_schedule_map
ON COMMIT DROP
AS
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, goal_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS retained_id,
    row_number() OVER (
      PARTITION BY workspace_id, goal_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS position
  FROM goal_funding_schedules
)
SELECT id AS duplicate_id, retained_id
FROM ranked
WHERE position > 1;

WITH ranked_runs AS (
  SELECT
    run.id,
    row_number() OVER (
      PARTITION BY
        COALESCE(duplicate.retained_id, run.schedule_id),
        run.due_on
      ORDER BY
        (duplicate.retained_id IS NULL) DESC,
        run.created_at DESC,
        run.id DESC
    ) AS position
  FROM goal_schedule_runs run
  LEFT JOIN duplicate_goal_schedule_map duplicate
    ON duplicate.duplicate_id = run.schedule_id
)
DELETE FROM goal_schedule_runs run
USING ranked_runs ranked
WHERE run.id = ranked.id
  AND ranked.position > 1;

UPDATE goal_schedule_runs run
SET schedule_id = duplicate.retained_id
FROM duplicate_goal_schedule_map duplicate
WHERE run.schedule_id = duplicate.duplicate_id;

DELETE FROM goal_funding_schedules schedule
USING duplicate_goal_schedule_map duplicate
WHERE schedule.id = duplicate.duplicate_id;

ALTER TABLE goal_funding_schedules
  ADD CONSTRAINT goal_funding_schedules_workspace_goal_unique
  UNIQUE (workspace_id, goal_id);

COMMIT;
