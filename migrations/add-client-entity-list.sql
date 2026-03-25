-- Entity list (clients) and the services provided to them
-- Supports Admin-maintained matrix:
-- NAME OF THE CLIENT | ENTITY TYPE | COST CENTRE | <service columns...>

-- Client entities (per organization)
CREATE TABLE IF NOT EXISTS client_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100), -- e.g. Individual, Company, Partnership (kept flexible)
    cost_centre_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
    pan VARCHAR(50),
    reporting_partner_mobile VARCHAR(20),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_client_entities_org_id ON client_entities(organization_id);
CREATE INDEX IF NOT EXISTS idx_client_entities_cost_centre_id ON client_entities(cost_centre_id);

-- Per-client service settings (one row per client per service)
CREATE TABLE IF NOT EXISTS client_entity_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_entity_id UUID NOT NULL REFERENCES client_entities(id) ON DELETE CASCADE,
    task_service_id UUID NOT NULL REFERENCES task_services(id) ON DELETE CASCADE,
    -- frequency can be overridden per client; NA typically means not applicable
    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half Yearly', 'Yearly', 'NA', 'Custom'
    )) DEFAULT 'NA',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_entity_id, task_service_id)
);
CREATE INDEX IF NOT EXISTS idx_client_entity_services_client_id ON client_entity_services(client_entity_id);
CREATE INDEX IF NOT EXISTS idx_client_entity_services_service_id ON client_entity_services(task_service_id);

