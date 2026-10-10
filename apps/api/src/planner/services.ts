import type { Db } from '../lib/db.js';
import { ACTIVE_SERVICES_SQL, dowColumn, type ServiceClock } from '../lib/service-time.js';

/** service_ids ativos por feed e data, com cache curto (a resposta só muda com novo feed ou novo dia). */
export class ServiceCalendar {
  private readonly cache = new Map<string, { at: number; ids: string[] }>();
  constructor(private readonly db: Db, private readonly ttlMs = 5 * 60_000) {}

  async active(feedId: number, day: ServiceClock): Promise<string[]> {
    const key = `${feedId}:${day.date}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.ids;
    const { rows } = await this.db.query<{ service_id: string }>(ACTIVE_SERVICES_SQL(dowColumn(day.dow)), [feedId, day.date]);
    const ids = rows.map((r) => r.service_id);
    this.cache.set(key, { at: Date.now(), ids });
    return ids;
  }
}
