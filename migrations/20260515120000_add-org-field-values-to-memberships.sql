-- Store org-structure level field values on employee memberships and client entities.
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS org_field_values JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS org_field_values JSONB NOT NULL DEFAULT '{}'::jsonb;
