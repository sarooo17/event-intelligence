/**
 * Fail-closed catalog contract for the bundled PostgreSQL v1 adapter.
 * Check physical shape, not just the version marker: CREATE TABLE IF NOT
 * EXISTS does not validate an existing relation's columns or constraints.
 */
const required = Object.freeze({
  records: {
    columns: { scope_id: 'text', kind: 'text', record_key: 'text',
      payload: 'jsonb', updated_at: 'timestamp with time zone' },
    primaryKey: ['scope_id', 'kind', 'record_key'],
  },
  history: {
    columns: { history_id: 'bigint', scope_id: 'text', kind: 'text',
      record_key: 'text', payload: 'jsonb',
      created_at: 'timestamp with time zone' },
    primaryKey: ['history_id'],
  },
  leases: {
    columns: { scope_id: 'text', lease_kind: 'text', lease_key: 'text',
      owner_id: 'text', lease_until: 'timestamp with time zone',
      updated_at: 'timestamp with time zone' },
    primaryKey: ['scope_id', 'lease_kind', 'lease_key'],
  },
  counters: {
    columns: { scope_id: 'text', name: 'text', value: 'bigint' },
    primaryKey: ['scope_id', 'name'],
  },
  metadata: {
    columns: { component: 'text', version: 'integer',
      adopted_from: 'text', created_at: 'timestamp with time zone' },
    primaryKey: ['component'],
  },
});

function malformed(detail) {
  const error = new Error(
    'Event Intelligence PostgreSQL schema shape is incompatible: ' + detail,
  );
  error.code = 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_SHAPE_INVALID';
  return error;
}

export async function assertPostgresSchemaShape(client, tablePrefix) {
  const names = Object.keys(required).map((suffix) =>
    tablePrefix + '_' + suffix
  );
  const columns = await client.query(
    'SELECT table_name, column_name, data_type, is_nullable ' +
    'FROM information_schema.columns ' +
    'WHERE table_schema = current_schema() AND table_name = ANY($1::text[])',
    [names],
  );
  const pks = await client.query(
    'SELECT tc.table_name, kcu.column_name, kcu.ordinal_position ' +
    'FROM information_schema.table_constraints AS tc ' +
    'JOIN information_schema.key_column_usage AS kcu ' +
    'ON tc.constraint_catalog = kcu.constraint_catalog ' +
    'AND tc.constraint_schema = kcu.constraint_schema ' +
    'AND tc.constraint_name = kcu.constraint_name ' +
    'AND tc.table_name = kcu.table_name ' +
    "WHERE tc.constraint_type = 'PRIMARY KEY' " +
    'AND tc.table_schema = current_schema() ' +
    'AND tc.table_name = ANY($1::text[]) ' +
    'ORDER BY tc.table_name, kcu.ordinal_position',
    [names],
  );
  for (const [suffix, config] of Object.entries(required)) {
    const name = tablePrefix + '_' + suffix;
    const actual = columns.rows.filter((column) => column.table_name === name);
    for (const [field, type] of Object.entries(config.columns)) {
      const column = actual.find((entry) => entry.column_name === field);
      if (!column || column.data_type !== type) {
        throw malformed(name + '.' + field + ' has wrong/missing type');
      }
      // PostgreSQL's ordinary nullable text fields are deliberate, but
      // every expected PK member must be constrained NOT NULL.
      if (config.primaryKey.includes(field) && column.is_nullable !== 'NO') {
        throw malformed(name + '.' + field + ' must be NOT NULL');
      }
    }
    const key = pks.rows
      .filter((row) => row.table_name === name)
      .sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position))
      .map((row) => row.column_name);
    if (JSON.stringify(key) !== JSON.stringify(config.primaryKey)) {
      throw malformed(name + ' has an unexpected primary key');
    }
  }
  return true;
}
