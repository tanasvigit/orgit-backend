import { query } from '../config/database';

let cached: {
  userProfile: boolean;
  membershipProfile: boolean;
} | null = null;

export async function getEmployeeMasterColumnCaps(): Promise<{
  userProfile: boolean;
  membershipProfile: boolean;
}> {
  if (cached) return cached;

  const userCols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN ('employee_code', 'email', 'date_of_birth', 'gender', 'address', 'pan_number')`
  );
  const uoCols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'user_organizations'
       AND column_name IN (
         'date_of_joining', 'employment_type', 'designation',
         'work_location_node_id', 'employee_permissions', 'notification_settings'
       )`
  );

  const userSet = new Set(userCols.rows.map((r: { column_name: string }) => r.column_name));
  const uoSet = new Set(uoCols.rows.map((r: { column_name: string }) => r.column_name));

  cached = {
    userProfile: userSet.has('employee_code'),
    membershipProfile: uoSet.has('employee_permissions'),
  };
  return cached;
}

export function resetEmployeeMasterColumnCache(): void {
  cached = null;
}
