export type QueryClient = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
};

export type UserForeignKey = {
  tableName: string;
  columnName: string;
  deleteRule: string;
  isNullable: boolean;
};

/**
 * Product-owned rows to remove with the user, using whatever matching
 * columns exist on the connected database.
 */
export const OWNED_USER_DELETE_TARGETS: Array<{ table: string; columns: string[] }> = [
  { table: 'message_status', columns: ['user_id'] },
  { table: 'starred_messages', columns: ['user_id'] },
  { table: 'message_reactions', columns: ['user_id'] },
  { table: 'messages', columns: ['sender_id'] },
  { table: 'conversation_members', columns: ['user_id'] },
  { table: 'group_members', columns: ['user_id'] },
  {
    table: 'task_assignments',
    columns: ['user_id', 'assigned_to_user_id', 'assigned_by_user_id'],
  },
  { table: 'task_assignees', columns: ['user_id'] },
  { table: 'task_template_assignees', columns: ['user_id'] },
  { table: 'task_activities', columns: ['user_id'] },
  { table: 'task_status_logs', columns: ['changed_by_user_id', 'user_id'] },
  { table: 'tasks', columns: ['creator_id', 'created_by'] },
  { table: 'notifications', columns: ['user_id'] },
  { table: 'contacts', columns: ['user_id', 'registered_user_id'] },
  { table: 'sessions', columns: ['user_id'] },
  { table: 'user_push_tokens', columns: ['user_id'] },
  { table: 'profiles', columns: ['user_id'] },
  { table: 'user_organizations', columns: ['user_id'] },
];

export function quoteIdent(name: string): string {
  if (!name || name.length > 63) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

const isMissingRelationError = (error: any): boolean =>
  error?.code === '42P01' || error?.code === '42703';

async function execIgnoreMissing(
  client: QueryClient,
  sql: string,
  params: any[] = []
): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (error: any) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
  }
}

export async function loadPublicTableColumns(
  client: QueryClient
): Promise<Map<string, Set<string>>> {
  const result = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const tableName = String(row.table_name);
    let columns = columnsByTable.get(tableName);
    if (!columns) {
      columns = new Set<string>();
      columnsByTable.set(tableName, columns);
    }
    columns.add(String(row.column_name));
  }
  return columnsByTable;
}

export async function loadForeignKeysToUsers(
  client: QueryClient
): Promise<UserForeignKey[]> {
  const result = await client.query(
    `SELECT
       src.relname AS table_name,
       att.attname AS column_name,
       CASE con.confdeltype
         WHEN 'a' THEN 'NO ACTION'
         WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE'
         WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
         ELSE 'NO ACTION'
       END AS delete_rule,
       CASE WHEN att.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = src.relnamespace
     JOIN pg_class dst ON dst.oid = con.confrelid
     JOIN pg_namespace dst_nsp ON dst_nsp.oid = dst.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_cols(attnum, ord) ON true
     JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS dst_cols(attnum, ord)
       ON dst_cols.ord = src_cols.ord
     JOIN pg_attribute att
       ON att.attrelid = src.oid AND att.attnum = src_cols.attnum
     JOIN pg_attribute dst_att
       ON dst_att.attrelid = dst.oid AND dst_att.attnum = dst_cols.attnum
     WHERE con.contype = 'f'
       AND nsp.nspname = 'public'
       AND dst_nsp.nspname = 'public'
       AND dst.relname = 'users'
       AND dst_att.attname = 'id'`
  );

  return result.rows.map((row) => ({
    tableName: String(row.table_name),
    columnName: String(row.column_name),
    deleteRule: String(row.delete_rule || 'NO ACTION').toUpperCase(),
    isNullable: String(row.is_nullable).toUpperCase() === 'YES',
  }));
}

function existingColumns(
  columnsByTable: Map<string, Set<string>>,
  table: string,
  candidates: string[]
): string[] {
  const columns = columnsByTable.get(table);
  if (!columns) {
    return [];
  }
  return candidates.filter((column) => columns.has(column));
}

function shouldNullForeignKey(fk: UserForeignKey): boolean {
  if (fk.tableName === 'users') {
    return true;
  }
  if (fk.deleteRule === 'SET NULL' || fk.deleteRule === 'SET DEFAULT') {
    return true;
  }
  return fk.isNullable && fk.deleteRule !== 'CASCADE';
}

export async function cleanupUserDependentRows(
  client: QueryClient,
  userId: string
): Promise<void> {
  const columnsByTable = await loadPublicTableColumns(client);

  const deleteOwnedRows = async () => {
    for (const target of OWNED_USER_DELETE_TARGETS) {
      const columns = existingColumns(columnsByTable, target.table, target.columns);
      if (columns.length === 0) {
        continue;
      }
      const where = columns.map((column) => `${quoteIdent(column)} = $1`).join(' OR ');
      try {
        await client.query(`DELETE FROM ${quoteIdent(target.table)} WHERE ${where}`, [userId]);
      } catch (error: any) {
        if (isMissingRelationError(error) || error?.code === '23503') {
          continue;
        }
        throw error;
      }
    }
  };

  await deleteOwnedRows();

  const foreignKeys = await loadForeignKeysToUsers(client);
  const nullUpdates = new Map<string, string[]>();
  const rowDeletes = new Map<string, string[]>();

  for (const fk of foreignKeys) {
    if (!columnsByTable.get(fk.tableName)?.has(fk.columnName)) {
      continue;
    }
    const bucket = shouldNullForeignKey(fk) ? nullUpdates : rowDeletes;
    const columns = bucket.get(fk.tableName) || [];
    if (!columns.includes(fk.columnName)) {
      columns.push(fk.columnName);
      bucket.set(fk.tableName, columns);
    }
  }

  for (const [table, columns] of nullUpdates) {
    for (const column of columns) {
      await execIgnoreMissing(
        client,
        `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = NULL WHERE ${quoteIdent(column)} = $1`,
        [userId]
      );
    }
  }

  await deleteOwnedRows();

  for (let pass = 0; pass < 3; pass++) {
    let blockedByFk = false;
    for (const [table, columns] of rowDeletes) {
      if (table === 'users') {
        continue;
      }
      const where = columns.map((column) => `${quoteIdent(column)} = $1`).join(' OR ');
      try {
        await client.query(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`, [userId]);
      } catch (error: any) {
        if (isMissingRelationError(error)) {
          continue;
        }
        if (error?.code === '23503') {
          blockedByFk = true;
          continue;
        }
        throw error;
      }
    }
    if (!blockedByFk) {
      break;
    }
  }

  const otpColumns = columnsByTable.get('otp_verifications');
  const userColumns = columnsByTable.get('users');
  if (otpColumns?.has('mobile') && userColumns?.has('mobile')) {
    await execIgnoreMissing(
      client,
      `DELETE FROM ${quoteIdent('otp_verifications')} WHERE mobile = (SELECT mobile FROM ${quoteIdent('users')} WHERE id = $1)`,
      [userId]
    );
  }
}
