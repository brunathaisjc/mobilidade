import pg from 'pg';

// Retorna DATE como string 'YYYY-MM-DD' (sem conversão de fuso) e BIGINT como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;

export function createDb(connectionString: string, max = 20): Db {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: 'mobigo-api' });
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
