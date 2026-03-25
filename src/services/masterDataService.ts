import { query } from '../config/database';

export interface Country {
  id: string;
  name: string;
  code?: string;
}

export interface State {
  id: string;
  country_id: string;
  name: string;
}

export interface City {
  id: string;
  state_id: string;
  name: string;
}

export interface OrgConstitutionOption {
  value: string;
  label: string;
}

const ORG_CONSTITUTIONS: OrgConstitutionOption[] = [
  { value: 'proprietor', label: 'Proprietor' },
  { value: 'partnership_firm', label: 'Partnership Firm' },
  { value: 'private_limited_company', label: 'Private Limited Company' },
  { value: 'public_limited_company', label: 'Public Limited Company' },
  { value: 'trust', label: 'Trust' },
  { value: 'society', label: 'Society' },
  { value: 'co_operative_society', label: 'Co-Operative Society' },
  { value: 'association_of_persons', label: 'Association of Persons' },
];

export async function getCountries(): Promise<Country[]> {
  const result = await query(
    'SELECT id, name, code FROM countries ORDER BY name',
    []
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    code: row.code,
  }));
}

export async function getStatesByCountry(countryId: string): Promise<State[]> {
  const result = await query(
    'SELECT id, country_id, name FROM states WHERE country_id = $1 ORDER BY name',
    [countryId]
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    country_id: row.country_id,
    name: row.name,
  }));
}

export async function getCitiesByState(stateId: string): Promise<City[]> {
  const result = await query(
    'SELECT id, state_id, name FROM cities WHERE state_id = $1 ORDER BY name',
    [stateId]
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    state_id: row.state_id,
    name: row.name,
  }));
}

export function getOrgConstitutions(): OrgConstitutionOption[] {
  return ORG_CONSTITUTIONS;
}

/** Same order as UI dropdown; used for Excel dropdown and parser label→value mapping */
export const ORG_CONSTITUTION_OPTIONS = ORG_CONSTITUTIONS;

export const ORG_CONSTITUTION_VALUES = ORG_CONSTITUTIONS.map((o) => o.value);

// ---------------------------------------------------------------------------
// Services / Task list master (Recurring + One-Time)
// ---------------------------------------------------------------------------
export type TaskServiceType = 'recurring' | 'one_time';
export type TaskServiceFrequency =
  | 'Daily'
  | 'Weekly'
  | 'Fortnightly'
  | 'Monthly'
  | 'Quarterly'
  | 'Half Yearly'
  | 'Yearly'
  | 'NA'
  | 'Custom';

export type TaskServiceRolloutRule = 'end_of_period' | 'one_month_before_period_end';

export interface TaskServiceItem {
  id: string;
  title: string;
  task_type: TaskServiceType;
  frequency: TaskServiceFrequency;
  rollout_rule: TaskServiceRolloutRule;
  is_active: boolean;
}

export const TASK_FREQUENCY_OPTIONS: Array<{ value: TaskServiceFrequency; label: string }> = [
  { value: 'Daily', label: 'Daily' },
  { value: 'Weekly', label: 'Weekly' },
  { value: 'Fortnightly', label: 'Fortnightly' },
  { value: 'Monthly', label: 'Monthly' },
  { value: 'Quarterly', label: 'Quarterly' },
  { value: 'Half Yearly', label: 'Half Yearly' },
  { value: 'Yearly', label: 'Yearly' },
  { value: 'NA', label: 'NA' },
  { value: 'Custom', label: 'Custom' },
];

export async function getTaskServices(params?: {
  taskType?: TaskServiceType;
  includeInactive?: boolean;
  organizationId?: string | null;
}): Promise<TaskServiceItem[]> {
  const taskType = params?.taskType;
  const includeInactive = params?.includeInactive === true;
  const organizationId = params?.organizationId ?? null;

  const conditions: string[] = [];
  const values: any[] = [];
  let i = 1;

  // Prefer org-specific records if organizationId provided; also include global (NULL) records.
  if (organizationId) {
    conditions.push(`(organization_id = $${i} OR organization_id IS NULL)`);
    values.push(organizationId);
    i++;
  } else {
    conditions.push(`organization_id IS NULL`);
  }

  if (taskType) {
    conditions.push(`task_type = $${i}`);
    values.push(taskType);
    i++;
  }

  if (!includeInactive) {
    conditions.push(`is_active = TRUE`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT id, title, task_type, frequency, rollout_rule, is_active
     FROM task_services
     ${where}
     ORDER BY task_type ASC, title ASC`,
    values
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    task_type: r.task_type,
    frequency: r.frequency,
    rollout_rule: r.rollout_rule,
    is_active: r.is_active,
  }));
}

const ROLLOUT_RULES: TaskServiceRolloutRule[] = ['end_of_period', 'one_month_before_period_end'];

export async function createTaskService(
  organizationId: string,
  body: { title: string; task_type: TaskServiceType; frequency?: TaskServiceFrequency; rollout_rule?: TaskServiceRolloutRule }
): Promise<TaskServiceItem> {
  const title = (body.title || '').trim().slice(0, 500);
  if (!title) throw new Error('Title is required');
  if (!body.task_type || !['recurring', 'one_time'].includes(body.task_type))
    throw new Error('task_type must be recurring or one_time');
  const frequency =
    body.task_type === 'recurring'
      ? (body.frequency && TASK_FREQUENCY_OPTIONS.some((o) => o.value === body.frequency) ? body.frequency : 'NA')
      : 'NA';
  const rollout_rule =
    body.task_type === 'recurring' && body.rollout_rule && ROLLOUT_RULES.includes(body.rollout_rule)
      ? body.rollout_rule
      : 'end_of_period';
  const result = await query(
    `INSERT INTO task_services (organization_id, title, task_type, frequency, rollout_rule, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id, title, task_type, frequency, rollout_rule, is_active`,
    [organizationId, title, body.task_type, frequency, rollout_rule]
  );
  const r = result.rows[0];
  return {
    id: r.id,
    title: r.title,
    task_type: r.task_type,
    frequency: r.frequency,
    rollout_rule: r.rollout_rule,
    is_active: r.is_active,
  };
}
