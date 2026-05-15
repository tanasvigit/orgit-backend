-- Employee org-assignment support.
-- Reporting_to is retained; flat level metadata is retired.

-- Ensure updated_at exists (employeeController updates it)
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- reporting_to: manager user id (same organization)
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS reporting_to UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_organizations_reporting_to ON user_organizations(reporting_to);
