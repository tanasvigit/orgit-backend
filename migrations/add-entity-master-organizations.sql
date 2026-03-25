-- Entity Master Data: Alter organizations table with new columns
-- Run after add-entity-master-master-tables.sql (countries, states, cities must exist)

-- Add new columns (all nullable for backward compatibility)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS short_name VARCHAR(100);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS country_id UUID REFERENCES countries(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS state_id UUID REFERENCES states(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pin_code VARCHAR(20);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(500);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(500);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website VARCHAR(500);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS depot_count INTEGER DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS warehouse_count INTEGER DEFAULT 0;

-- Org constitution: CHECK with 8 values (stored as snake_case)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS org_constitution VARCHAR(50);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_org_constitution_check'
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_org_constitution_check
    CHECK (org_constitution IS NULL OR org_constitution IN (
      'proprietor',
      'partnership_firm',
      'private_limited_company',
      'public_limited_company',
      'trust',
      'society',
      'co_operative_society',
      'association_of_persons'
    ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizations_country_id ON organizations(country_id);
CREATE INDEX IF NOT EXISTS idx_organizations_state_id ON organizations(state_id);
CREATE INDEX IF NOT EXISTS idx_organizations_city_id ON organizations(city_id);
