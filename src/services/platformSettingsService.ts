import { query } from '../config/database';
import { PlatformSettings } from '../../shared/src/types';

/**
 * Get all platform settings
 */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const result = await query(
    `SELECT setting_key, setting_value FROM platform_settings`,
    []
  );

  const settings: any = {};
  result.rows.forEach((row: any) => {
    settings[row.setting_key] = row.setting_value;
  });

  return {
    autoEscalation: settings.auto_escalation || {
      enabled: true,
      unacceptedHours: 24,
      overdueDays: 2,
      missedRecurrenceEnabled: true,
    },
    reminder: settings.reminder || {
      dueSoonDays: 3,
      pushEnabled: true,
      emailEnabled: true,
      reminderIntervals: [24, 12, 6],
    },
    recurringTasks: settings.recurring_tasks || {
      defaultFrequencies: ['weekly', 'monthly', 'quarterly', 'yearly'],
      autoCalculateDueDate: true,
      escalationEnabled: true,
    },
    system: settings.system || {
      maintenanceMode: false,
      features: {},
    },
  };
}

/**
 * Get specific setting by key
 */
export async function getSetting(key: string): Promise<any> {
  const result = await query(
    `SELECT setting_value FROM platform_settings WHERE setting_key = $1`,
    [key]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].setting_value;
}

/**
 * Update setting
 */
export async function updateSetting(
  key: string,
  value: any,
  userId: string
): Promise<void> {
  await query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (setting_key) 
     DO UPDATE SET setting_value = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value), userId]
  );
}

/**
 * Get auto-escalation configuration
 */
export async function getAutoEscalationConfig(): Promise<PlatformSettings['autoEscalation']> {
  const setting = await getSetting('auto_escalation');
  if (!setting) {
    return {
      enabled: true,
      unacceptedHours: 24,
      overdueDays: 2,
      missedRecurrenceEnabled: true,
    };
  }
  return setting;
}

/**
 * Update auto-escalation configuration
 */
export async function updateAutoEscalationConfig(
  config: PlatformSettings['autoEscalation'],
  userId: string
): Promise<void> {
  // Validate config
  if (config.unacceptedHours < 1 || config.unacceptedHours > 168) {
    throw new Error('Unaccepted hours must be between 1 and 168');
  }
  if (config.overdueDays < 1 || config.overdueDays > 30) {
    throw new Error('Overdue days must be between 1 and 30');
  }

  await updateSetting('auto_escalation', config, userId);
}

/**
 * Get reminder configuration
 */
export async function getReminderConfig(): Promise<PlatformSettings['reminder']> {
  const setting = await getSetting('reminder');
  if (!setting) {
    return {
      dueSoonDays: 3,
      pushEnabled: true,
      emailEnabled: true,
      reminderIntervals: [24, 12, 6],
    };
  }
  return setting;
}

/**
 * Update reminder configuration
 */
export async function updateReminderConfig(
  config: PlatformSettings['reminder'],
  userId: string
): Promise<void> {
  // Validate config
  if (config.dueSoonDays < 1 || config.dueSoonDays > 30) {
    throw new Error('Due soon days must be between 1 and 30');
  }
  if (!Array.isArray(config.reminderIntervals) || config.reminderIntervals.length === 0) {
    throw new Error('Reminder intervals must be a non-empty array');
  }
  if (config.reminderIntervals.some((interval: number) => interval < 1 || interval > 168)) {
    throw new Error('Reminder intervals must be between 1 and 168 hours');
  }

  await updateSetting('reminder', config, userId);
}

/**
 * Get recurring task settings
 */
export async function getRecurringTaskSettings(): Promise<PlatformSettings['recurringTasks']> {
  const setting = await getSetting('recurring_tasks');
  if (!setting) {
    return {
      defaultFrequencies: ['weekly', 'monthly', 'quarterly', 'yearly'],
      autoCalculateDueDate: true,
      escalationEnabled: true,
    };
  }
  return setting;
}

/**
 * Update recurring task settings
 */
export async function updateRecurringTaskSettings(
  settings: PlatformSettings['recurringTasks'],
  userId: string
): Promise<void> {
  // Validate settings
  if (!Array.isArray(settings.defaultFrequencies) || settings.defaultFrequencies.length === 0) {
    throw new Error('Default frequencies must be a non-empty array');
  }

  const validFrequencies = ['weekly', 'monthly', 'quarterly', 'yearly', 'specific_weekday'];
  if (!settings.defaultFrequencies.every((freq: string) => validFrequencies.includes(freq))) {
    throw new Error(`Invalid frequency. Valid values: ${validFrequencies.join(', ')}`);
  }

  await updateSetting('recurring_tasks', settings, userId);
}

/**
 * Get system settings
 */
export async function getSystemSettings(): Promise<PlatformSettings['system']> {
  const setting = await getSetting('system');
  if (!setting) {
    return {
      maintenanceMode: false,
      features: {},
    };
  }
  return setting;
}

/**
 * Update system settings
 */
export async function updateSystemSettings(
  settings: PlatformSettings['system'],
  userId: string
): Promise<void> {
  await updateSetting('system', settings, userId);
}

