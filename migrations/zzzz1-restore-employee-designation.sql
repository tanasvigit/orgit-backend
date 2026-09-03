-- Restore employee job-title column removed by an earlier version of
-- zzzz-drop-legacy-org-model.sql (that migration dropped designation as "legacy"
-- but employee master still stores a free-text designation on memberships).

ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS designation VARCHAR(255);

COMMENT ON COLUMN user_organizations.designation IS
  'Employee job title / designation (free text). Distinct from dropped designations master table.';
