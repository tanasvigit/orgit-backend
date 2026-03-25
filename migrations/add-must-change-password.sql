-- First-time login: prompt user to change password (bulk-uploaded employees).
-- When they change password or skip, set must_change_password = false.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;

COMMENT ON COLUMN users.must_change_password IS 'When true, show change-password popup after login (e.g. bulk-uploaded employees). Cleared on change password or skip.';
