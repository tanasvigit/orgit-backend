-- Migration: Create user_documents table (filled documents from templates)
-- Used by Document Library / Document Create / Document Access flow

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
