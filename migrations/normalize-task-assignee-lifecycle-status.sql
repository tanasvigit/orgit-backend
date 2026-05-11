-- One-time normalization for legacy assignee lifecycle rows after lifecycle rollout.
UPDATE task_assignees
SET status = 'todo'
WHERE verified_at IS NULL
  AND completed_at IS NULL
  AND lower(status) IN ('accepted', 'active');

UPDATE task_assignees ta
SET status = 'todo'
FROM tasks t
WHERE ta.task_id = t.id
  AND ta.verified_at IS NULL
  AND ta.completed_at IS NULL
  AND ta.status = 'scheduled'
  AND t.start_date IS NOT NULL
  AND t.start_date::date <= CURRENT_DATE;

UPDATE task_assignees ta
SET status = 'todo'
FROM tasks t
WHERE ta.task_id = t.id
  AND ta.verified_at IS NULL
  AND ta.completed_at IS NULL
  AND ta.status IN ('inprogress', 'in_progress')
  AND t.start_date IS NOT NULL
  AND t.start_date::date > CURRENT_DATE;
