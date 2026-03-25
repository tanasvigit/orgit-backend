-- Services / Task List Master
-- Supports:
-- - RECURRING TASK TITLE/SERVICE LIST (frequency + task roll out)
-- - ONE TIME TASK LIST
-- - FREQUENCY dropdown values (Daily, Weekly, Fortnightly, Monthly, Quarterly, Half Yearly, Yearly, NA, Custom)

CREATE TABLE IF NOT EXISTS task_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global master list
    title VARCHAR(500) NOT NULL,
    task_type VARCHAR(50) NOT NULL CHECK (task_type IN ('recurring', 'one_time')),
    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half Yearly', 'Yearly', 'NA', 'Custom'
    )),
    rollout_rule VARCHAR(50) NOT NULL CHECK (rollout_rule IN (
        'end_of_period', 'one_month_before_period_end'
    )),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, title, task_type)
);

CREATE INDEX IF NOT EXISTS idx_task_services_org_id ON task_services(organization_id);
CREATE INDEX IF NOT EXISTS idx_task_services_type ON task_services(task_type);
CREATE INDEX IF NOT EXISTS idx_task_services_active ON task_services(is_active);

-- No seed data: users add services via single create or bulk upload (Service List sheet).

