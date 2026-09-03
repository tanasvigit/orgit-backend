-- Link anchor tasks to their recurrence templates (legacy rows).
UPDATE tasks t
SET recurrence_template_id = trt.id,
    parent_task_id = COALESCE(t.parent_task_id, trt.id),
    recurrence_instance_no = COALESCE(t.recurrence_instance_no, 1),
    updated_at = NOW()
FROM task_recurrence_templates trt
WHERE trt.task_id = t.id
  AND t.recurrence_template_id IS NULL;
