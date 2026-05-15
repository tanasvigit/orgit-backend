import { query } from '../config/database';

let userOrganizationsHasColumn: boolean | null = null;
let clientEntitiesHasColumn: boolean | null = null;

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

export async function userOrganizationsHasOrgFieldValues(): Promise<boolean> {
  if (userOrganizationsHasColumn === null) {
    userOrganizationsHasColumn = await columnExists('user_organizations', 'org_field_values');
  }
  return userOrganizationsHasColumn;
}

export async function clientEntitiesHasOrgFieldValues(): Promise<boolean> {
  if (clientEntitiesHasColumn === null) {
    clientEntitiesHasColumn = await columnExists('client_entities', 'org_field_values');
  }
  return clientEntitiesHasColumn;
}

/** Call after running migration so next request picks up new columns. */
export function resetOrgFieldValuesColumnCache(): void {
  userOrganizationsHasColumn = null;
  clientEntitiesHasColumn = null;
}
