-- =============================================================================
-- Entity Master Data: ALL UPDATES IN ONE SCRIPT
-- Run this ONCE after your base schema (organizations table must exist).
-- Order: 1) Create tables 2) Seed 3) Alter organizations 4) Create cost_centres/branches
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CREATE MASTER TABLES (countries, states, cities)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS countries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(10)
);
CREATE INDEX IF NOT EXISTS idx_countries_code ON countries(code);

CREATE TABLE IF NOT EXISTS states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    UNIQUE(country_id, name)
);
CREATE INDEX IF NOT EXISTS idx_states_country_id ON states(country_id);

CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    UNIQUE(state_id, name)
);
CREATE INDEX IF NOT EXISTS idx_cities_state_id ON cities(state_id);

-- -----------------------------------------------------------------------------
-- 2. SEED DATA (India, states, cities)
-- -----------------------------------------------------------------------------
INSERT INTO countries (id, name, code) VALUES
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'India', 'IN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO states (country_id, name) VALUES
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Andhra Pradesh'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Telangana'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Karnataka'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Tamil Nadu'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Kerala'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Maharashtra'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Gujarat'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Rajasthan'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'West Bengal'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Delhi'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Uttar Pradesh'),
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'Odisha')
ON CONFLICT (country_id, name) DO NOTHING;

INSERT INTO cities (state_id, name)
SELECT s.id, 'Visakhapatnam' FROM states s WHERE s.name = 'Andhra Pradesh' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Vijayawada' FROM states s WHERE s.name = 'Andhra Pradesh' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Hyderabad' FROM states s WHERE s.name = 'Telangana' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Bengaluru' FROM states s WHERE s.name = 'Karnataka' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Chennai' FROM states s WHERE s.name = 'Tamil Nadu' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Thiruvananthapuram' FROM states s WHERE s.name = 'Kerala' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Mumbai' FROM states s WHERE s.name = 'Maharashtra' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Ahmedabad' FROM states s WHERE s.name = 'Gujarat' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Jaipur' FROM states s WHERE s.name = 'Rajasthan' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Kolkata' FROM states s WHERE s.name = 'West Bengal' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'New Delhi' FROM states s WHERE s.name = 'Delhi' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Lucknow' FROM states s WHERE s.name = 'Uttar Pradesh' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;
INSERT INTO cities (state_id, name)
SELECT s.id, 'Bhubaneswar' FROM states s WHERE s.name = 'Odisha' AND s.country_id = 'a1b2c3d4-e5f6-4789-a012-345678901234' LIMIT 1
ON CONFLICT (state_id, name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. ALTER ORGANIZATIONS (new Entity Master columns)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 4. CREATE COST_CENTRES AND BRANCHES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_centres (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_cost_centres_organization_id ON cost_centres(organization_id);

CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    address TEXT,
    gst_number VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_branches_organization_id ON branches(organization_id);
