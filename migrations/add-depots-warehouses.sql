-- Depot and Warehouse master (like Cost Centres and Branches)
-- Run after add-entity-master-cost-centres-branches.sql

-- Depots (per organization)
CREATE TABLE IF NOT EXISTS depots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_depots_organization_id ON depots(organization_id);

-- Warehouses (per organization)
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    address TEXT,
    gst_number VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_warehouses_organization_id ON warehouses(organization_id);

-- Add Depot and Warehouse to client entities (like cost_centre_id)
ALTER TABLE client_entities ADD COLUMN IF NOT EXISTS depot_id UUID REFERENCES depots(id) ON DELETE SET NULL;
ALTER TABLE client_entities ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_client_entities_depot_id ON client_entities(depot_id);
CREATE INDEX IF NOT EXISTS idx_client_entities_warehouse_id ON client_entities(warehouse_id);
