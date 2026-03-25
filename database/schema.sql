-- =====================================================
-- ORGIT Backend Database Schema
-- Base Schema for PostgreSQL
-- =====================================================
-- This script creates all base tables required for the application.
-- Run this script BEFORE running migrations.
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For text search

-- =====================================================
-- 1. CORE TABLES
-- =====================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    password_hash VARCHAR(255),
    role VARCHAR(50) DEFAULT 'employee' CHECK (role IN ('super_admin', 'admin', 'employee')),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    profile_photo_url TEXT,
    bio TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- =====================================================
-- Entity Master: Countries, States, Cities (for dropdowns)
-- =====================================================
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

-- Organizations table (with Entity Master fields)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    logo_url TEXT,
    address TEXT,
    country_id UUID REFERENCES countries(id) ON DELETE SET NULL,
    state_id UUID REFERENCES states(id) ON DELETE SET NULL,
    city_id UUID REFERENCES cities(id) ON DELETE SET NULL,
    pin_code VARCHAR(20),
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    email VARCHAR(255),
    mobile VARCHAR(20),
    website VARCHAR(500),
    phone_number VARCHAR(20),
    gst VARCHAR(50),
    pan VARCHAR(50),
    cin VARCHAR(50),
    org_constitution VARCHAR(50) CHECK (org_constitution IS NULL OR org_constitution IN (
        'proprietor', 'partnership_firm', 'private_limited_company', 'public_limited_company',
        'trust', 'society', 'co_operative_society', 'association_of_persons'
    )),
    depot_count INTEGER DEFAULT 0,
    warehouse_count INTEGER DEFAULT 0,
    accounting_year_start DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
CREATE INDEX IF NOT EXISTS idx_organizations_country_id ON organizations(country_id);
CREATE INDEX IF NOT EXISTS idx_organizations_state_id ON organizations(state_id);
CREATE INDEX IF NOT EXISTS idx_organizations_city_id ON organizations(city_id);

-- User-Organization relationship (many-to-many)
CREATE TABLE IF NOT EXISTS user_organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    department VARCHAR(255),
    designation VARCHAR(255),
    reporting_to UUID REFERENCES users(id) ON DELETE SET NULL,
    level VARCHAR(20),
    role VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_user_organizations_user_id ON user_organizations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_organizations_org_id ON user_organizations(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_organizations_reporting_to ON user_organizations(reporting_to);

-- Services / Task list master (Recurring + One-Time)
CREATE TABLE IF NOT EXISTS task_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global master list
    title VARCHAR(500) NOT NULL,
    task_type VARCHAR(50) NOT NULL CHECK (task_type IN ('recurring', 'one_time')),
    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half Yearly', 'Yearly', 'NA', 'Custom'
    )),
    rollout_rule VARCHAR(50) NOT NULL CHECK (rollout_rule IN (
        'end_of_period', 'one_month_before_period_end'
    )),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, title, task_type)
);
CREATE INDEX IF NOT EXISTS idx_task_services_org_id ON task_services(organization_id);
CREATE INDEX IF NOT EXISTS idx_task_services_type ON task_services(task_type);
CREATE INDEX IF NOT EXISTS idx_task_services_active ON task_services(is_active);

-- Cost centres (per organization)
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

-- Client entity list (per organization) and service matrix
CREATE TABLE IF NOT EXISTS client_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100),
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

CREATE TABLE IF NOT EXISTS client_entity_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_entity_id UUID NOT NULL REFERENCES client_entities(id) ON DELETE CASCADE,
    task_service_id UUID NOT NULL REFERENCES task_services(id) ON DELETE CASCADE,
    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half Yearly', 'Yearly', 'NA', 'Custom'
    )) DEFAULT 'NA',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_entity_id, task_service_id)
);
CREATE INDEX IF NOT EXISTS idx_client_entity_services_client_id ON client_entity_services(client_entity_id);
CREATE INDEX IF NOT EXISTS idx_client_entity_services_service_id ON client_entity_services(task_service_id);

-- Branches (per organization)
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

-- Add depot_id and warehouse_id to client_entities (FKs added by migration if not in base schema)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'depot_id') THEN
    ALTER TABLE client_entities ADD COLUMN depot_id UUID REFERENCES depots(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_client_entities_depot_id ON client_entities(depot_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'warehouse_id') THEN
    ALTER TABLE client_entities ADD COLUMN warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_client_entities_warehouse_id ON client_entities(warehouse_id);
  END IF;
END $$;

-- =====================================================
-- 2. TASK MANAGEMENT TABLES
-- =====================================================

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL CHECK (task_type IN ('one_time', 'recurring')),
    creator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Legacy field
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    start_date TIMESTAMP,
    target_date TIMESTAMP,
    due_date TIMESTAMP,
    frequency VARCHAR(50) CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly', 'specific_weekday')),
    specific_weekday INTEGER CHECK (specific_weekday BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    next_recurrence_date TIMESTAMP,
    category VARCHAR(100) DEFAULT 'general',
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'overdue')),
    compliance_id UUID,
    client_name VARCHAR(255),
    reporting_member_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_creator_id ON tasks(creator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_organization_id ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_compliance_id ON tasks(compliance_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reporting_member_id ON tasks(reporting_member_id);

-- Task assignees table
CREATE TABLE IF NOT EXISTS task_assignees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_at TIMESTAMP,
    completed_at TIMESTAMP,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_task_id ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user_id ON task_assignees(user_id);

-- Task assignments table (alternative assignment tracking)
CREATE TABLE IF NOT EXISTS task_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    assigned_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_assigned_to ON task_assignments(assigned_to_user_id);

-- Task activities table (activity log)
CREATE TABLE IF NOT EXISTS task_activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_type VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_activities_task_id ON task_activities(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_user_id ON task_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_created_at ON task_activities(created_at);

-- Task status logs table
CREATE TABLE IF NOT EXISTS task_status_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    new_status VARCHAR(50) NOT NULL,
    changed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    change_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_status_logs_task_id ON task_status_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_status_logs_created_at ON task_status_logs(created_at);

-- =====================================================
-- 3. MESSAGING TABLES
-- =====================================================

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('direct', 'group')),
    name VARCHAR(255),
    is_group BOOLEAN DEFAULT FALSE,
    is_task_group BOOLEAN DEFAULT FALSE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    group_photo TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);
CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON conversations(created_by);

-- Conversation members table
CREATE TABLE IF NOT EXISTS conversation_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    is_pinned BOOLEAN DEFAULT FALSE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_conversation_id ON conversation_members(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user_id ON conversation_members(user_id);

-- Groups table (legacy, may be used alongside conversations)
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255),
    photo_url TEXT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_task_group BOOLEAN DEFAULT FALSE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_groups_created_by ON groups(created_by);
CREATE INDEX IF NOT EXISTS idx_groups_task_id ON groups(task_id);

-- Group members table
CREATE TABLE IF NOT EXISTS group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID REFERENCES users(id) ON DELETE SET NULL,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('text', 'image', 'video', 'audio', 'voice_note', 'document', 'location', 'contact', 'system')),
    content TEXT,
    media_url TEXT,
    media_thumbnail TEXT,
    file_name VARCHAR(255),
    file_size BIGINT,
    mime_type VARCHAR(100),
    duration INTEGER, -- For audio/video in seconds
    visibility_mode VARCHAR(50) DEFAULT 'shared_to_group' CHECK (visibility_mode IN ('shared_to_group', 'org_only', 'private')),
    sender_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    forwarded_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    deleted_for_all BOOLEAN DEFAULT FALSE,
    mentions JSONB DEFAULT '[]'::jsonb,
    task_mentions JSONB DEFAULT '[]'::jsonb,
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    location_address TEXT,
    is_live_location BOOLEAN DEFAULT FALSE,
    live_location_expires_at TIMESTAMP,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_id ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_org_id ON messages(sender_organization_id);
-- Index on reply_to_message_id only if column exists (table may exist from older schema; migration add-messages-reply-and-deleted-for-all adds column + index)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'reply_to_message_id') THEN
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages(reply_to_message_id);
  END IF;
END $$;

-- Message status table (delivery/read receipts)
CREATE TABLE IF NOT EXISTS message_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL CHECK (status IN ('sent', 'delivered', 'read')),
    status_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_status_message_id ON message_status(message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_user_id ON message_status(user_id);
CREATE INDEX IF NOT EXISTS idx_message_status_status ON message_status(status);

-- Starred messages table
CREATE TABLE IF NOT EXISTS starred_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_starred_messages_user_id ON starred_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_starred_messages_message_id ON starred_messages(message_id);

-- Message reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON message_reactions(user_id);

-- =====================================================
-- 4. DOCUMENT MANAGEMENT TABLES
-- =====================================================

-- Document templates table
CREATE TABLE IF NOT EXISTS document_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(100),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
    header_template TEXT,
    body_template TEXT,
    template_schema JSONB,
    auto_fill_fields JSONB,
    pdf_settings JSONB,
    version INTEGER DEFAULT 1,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_templates_status ON document_templates(status);
CREATE INDEX IF NOT EXISTS idx_document_templates_type ON document_templates(type);
CREATE INDEX IF NOT EXISTS idx_document_templates_created_by ON document_templates(created_by);

-- Document template versions table
CREATE TABLE IF NOT EXISTS document_template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    header_template TEXT,
    body_template TEXT,
    template_schema JSONB,
    auto_fill_fields JSONB,
    pdf_settings JSONB,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_document_template_versions_template_id ON document_template_versions(template_id);

-- Document instances table
CREATE TABLE IF NOT EXISTS document_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    filled_data JSONB NOT NULL,
    pdf_url TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'archived')),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_instances_template_id ON document_instances(template_id);
CREATE INDEX IF NOT EXISTS idx_document_instances_organization_id ON document_instances(organization_id);
CREATE INDEX IF NOT EXISTS idx_document_instances_status ON document_instances(status);
CREATE INDEX IF NOT EXISTS idx_document_instances_created_by ON document_instances(created_by);

-- User documents table (filled documents from templates: template_id, title, pdf_url)
CREATE TABLE IF NOT EXISTS user_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    pdf_url TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_documents_template_id ON user_documents(template_id);
CREATE INDEX IF NOT EXISTS idx_user_documents_organization_id ON user_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_documents_created_by ON user_documents(created_by);
CREATE INDEX IF NOT EXISTS idx_user_documents_created_at ON user_documents(created_at);

-- =====================================================
-- 5. COMPLIANCE TABLES
-- =====================================================

-- Compliance master table
CREATE TABLE IF NOT EXISTS compliance_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    category VARCHAR(255),
    act_name VARCHAR(255),
    description TEXT,
    compliance_type VARCHAR(50) NOT NULL CHECK (compliance_type IN ('ONE_TIME', 'RECURRING')),
    frequency VARCHAR(50) CHECK (frequency IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY')),
    effective_date DATE,
    status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    scope VARCHAR(50) DEFAULT 'GLOBAL' CHECK (scope IN ('GLOBAL', 'ORG')),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    version VARCHAR(50),
    -- Extended compliance metadata fields
    compliance_code VARCHAR(100),
    applicable_law VARCHAR(255),
    section_rule_reference VARCHAR(255),
    governing_authority VARCHAR(255),
    jurisdiction_type VARCHAR(100),
    state_applicability VARCHAR(255),
    industry_applicability VARCHAR(255),
    entity_type_applicability VARCHAR(255),
    applicability_threshold VARCHAR(255),
    mandatory_flag BOOLEAN DEFAULT FALSE,
    risk_level VARCHAR(50),
    penalty_summary TEXT,
    max_penalty_amount DECIMAL(15, 2),
    imprisonment_flag BOOLEAN DEFAULT FALSE,
    compliance_frequency VARCHAR(100),
    due_date_type VARCHAR(100),
    due_date DATE,
    due_date_rule TEXT,
    grace_period_days INTEGER,
    financial_year_applicable BOOLEAN DEFAULT FALSE,
    first_time_compliance BOOLEAN DEFAULT FALSE,
    trigger_event VARCHAR(255),
    approval_status VARCHAR(50),
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_role VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_compliance_master_category ON compliance_master(category);
CREATE INDEX IF NOT EXISTS idx_compliance_master_status ON compliance_master(status);
CREATE INDEX IF NOT EXISTS idx_compliance_master_scope ON compliance_master(scope);
CREATE INDEX IF NOT EXISTS idx_compliance_master_organization_id ON compliance_master(organization_id);

-- =====================================================
-- 6. NOTIFICATION & OTP TABLES
-- =====================================================

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL CHECK (type IN ('message_received', 'task_assigned', 'task_accepted', 'task_rejected', 'task_updated', 'task_overdue', 'task_escalated', 'group_member_added', 'document_shared')),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    related_entity_type VARCHAR(100),
    related_entity_id UUID,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);

-- OTP verifications table
CREATE TABLE IF NOT EXISTS otp_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile VARCHAR(20) NOT NULL,
    otp_code VARCHAR(10) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_otp_verifications_mobile ON otp_verifications(mobile);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_expires_at ON otp_verifications(expires_at);

-- =====================================================
-- 7. PLATFORM SETTINGS TABLE
-- =====================================================

-- Platform settings table
CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key VARCHAR(255) PRIMARY KEY,
    setting_value JSONB NOT NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 8. PROFILES TABLE (if used)
-- =====================================================

-- Profiles table (optional user profile extension)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    about TEXT,
    contact_number VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);

-- =====================================================
-- END OF SCHEMA
-- =====================================================

