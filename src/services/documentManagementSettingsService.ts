import { query } from '../config/database';

export interface DocumentManagementSettings {
  enabled: boolean;
  checkedByUserId?: string | null;
  approvedByUserId?: string | null;
}

function getSettingsKey(organizationId: string) {
  return `orgit.documentFlow.${organizationId}`;
}

export async function getDocumentManagementSettings(
  organizationId: string
): Promise<DocumentManagementSettings> {
  const key = getSettingsKey(organizationId);
  const result = await query(
    `SELECT setting_value
     FROM platform_settings
     WHERE setting_key = $1`,
    [key]
  );

  if (result.rows.length === 0) {
    return { enabled: false };
  }

  const value = result.rows[0]?.setting_value || {};
  return {
    enabled: !!value.enabled,
    checkedByUserId: value.checkedByUserId ?? null,
    approvedByUserId: value.approvedByUserId ?? null,
  };
}

export async function upsertDocumentManagementSettings(params: {
  organizationId: string;
  updatedByUserId: string;
  settings: DocumentManagementSettings;
}): Promise<DocumentManagementSettings> {
  const key = getSettingsKey(params.organizationId);
  const settings: DocumentManagementSettings = {
    enabled: !!params.settings.enabled,
    checkedByUserId: params.settings.checkedByUserId || null,
    approvedByUserId: params.settings.approvedByUserId || null,
  };

  await query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET setting_value = $2, updated_by = $3, updated_at = NOW()`,
    [key, JSON.stringify(settings), params.updatedByUserId]
  );

  return settings;
}

