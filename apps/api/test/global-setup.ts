/** Prepara o banco de teste: migra, limpa e carrega o GTFS sintético. Requer PostgreSQL+PostGIS e Redis. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/lib/db.js';
import { migrate } from '../src/scripts/migrate.js';
import { generateSampleGtfs } from '../src/scripts/generate-sample-gtfs.js';
import { loadGtfs } from '../src/scripts/load-gtfs.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mobi:mobi@localhost:5432/mobilidade_test';

export default async function setup() {
  const db = createDb(TEST_DATABASE_URL, 2);
  const dir = await mkdtemp(join(tmpdir(), 'mobigo-gtfs-'));
  try {
    await migrate(db, undefined, () => undefined);
    await db.query('TRUNCATE users, gtfs_feeds RESTART IDENTITY CASCADE');
    await generateSampleGtfs(dir);
    await loadGtfs(db, { slug: 'teste', name: 'Feed de teste', dir }, () => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await db.end();
  }
}
