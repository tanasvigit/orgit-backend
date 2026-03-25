-- Entity Master Data: Master tables for dropdowns (countries, states, cities)
-- Run after base schema. Seeds India + Indian states + initial cities.

-- Countries
CREATE TABLE IF NOT EXISTS countries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(10)
);
CREATE INDEX IF NOT EXISTS idx_countries_code ON countries(code);

-- States (e.g. Indian states)
CREATE TABLE IF NOT EXISTS states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    UNIQUE(country_id, name)
);
CREATE INDEX IF NOT EXISTS idx_states_country_id ON states(country_id);

-- Cities
CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    UNIQUE(state_id, name)
);
CREATE INDEX IF NOT EXISTS idx_cities_state_id ON cities(state_id);

-- Seed: India
INSERT INTO countries (id, name, code) VALUES
    ('a1b2c3d4-e5f6-4789-a012-345678901234', 'India', 'IN')
ON CONFLICT (id) DO NOTHING;

-- Seed: Indian states (subset; can extend)
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

-- Seed: Cities (one per state for initial set; use state id from states table)
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
