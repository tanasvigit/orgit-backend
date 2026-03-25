-- Add PAN, reporting partner mobile, and status to client entities

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS pan VARCHAR(50);

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS reporting_partner_mobile VARCHAR(20);

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'
  CHECK (status IN ('active', 'inactive'));

