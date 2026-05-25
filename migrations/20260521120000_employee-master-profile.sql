-- Employee master profile (personal, employment, permissions, notifications) per org membership.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code
  ON users (employee_code)
  WHERE employee_code IS NOT NULL AND TRIM(employee_code) <> '';

ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS date_of_joining DATE,
  ADD COLUMN IF NOT EXISTS employment_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS designation VARCHAR(255),
  ADD COLUMN IF NOT EXISTS work_location_node_id UUID REFERENCES organization_structure_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS employee_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notification_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_user_organizations_work_location
  ON user_organizations (work_location_node_id);

COMMENT ON COLUMN user_organizations.employee_permissions IS 'moduleAccess, rights, taskRights, workflowRoles, documentRights (see employeeMasterCatalog)';
COMMENT ON COLUMN user_organizations.notification_settings IS 'inApp, email, whatsapp, taskReminders, escalationAlerts';
