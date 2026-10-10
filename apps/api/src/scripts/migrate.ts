/** Aplica db/migrations/*.sql em ordem, cada arquivo em sua transação, registrando em schema_migrations. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { isMain } from '../lib/is-main.js';
import { createDb, type Db } from '../lib/db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

export async function migrate(db: Db, dir = MIGRATIONS_DIR, log: (m: string) => void = console.log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Evita duas réplicas migrando ao mesmo tempo durante um deploy.
      await client.query('SELECT pg_advisory_xact_lock(424242)');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`migração aplicada: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`falha na migração ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

if (isMain(import.meta.url)) {
  const db = createDb(loadConfig().DATABASE_URL, 2);
  migrate(db)
    .then(() => console.log('banco atualizado'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
