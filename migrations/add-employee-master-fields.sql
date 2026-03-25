-- Employee Master Data: extend user_organizations with reporting_to + level
-- This supports: NAME, MOBILE, DESIGNATION, REPORTING TO, LEVEL (L1/L2/...)

-- Ensure updated_at exists (employeeController updates it)
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- reporting_to: manager user id (same organization)
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS reporting_to UUID REFERENCES users(id) ON DELETE SET NULL;

-- level: e.g. L1, L2 (kept flexible)
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS level VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_user_organizations_reporting_to ON user_organizations(reporting_to);
