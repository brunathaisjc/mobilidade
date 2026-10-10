import type { PlanRequest, PlanResponse } from '@mobigo/shared';
import type { Config } from '../config.js';
import type { Db } from '../lib/db.js';
import { FeedRegistry } from '../realtime/gtfs-cache.js';
import type { RealtimeStore } from '../realtime/store.js';
import { DirectPlanner } from './direct.js';
import { OtpPlanner } from './otp.js';
import { ServiceCalendar } from './services.js';

export interface Planner {
  plan(req: PlanRequest): Promise<PlanResponse>;
  readonly feeds: FeedRegistry;
}

export function createPlanner(cfg: Config, db: Db, store: RealtimeStore): Planner {
  const feeds = new FeedRegistry(db);
  const deps = {
    db, feeds, calendar: new ServiceCalendar(db),
    vehiclesByRoute: (r: string) => store.vehiclesByRoute(r),
    maxWalkMeters: cfg.MAX_WALK_METERS,
  };
  const direct = new DirectPlanner(deps);
  // OTP faz transbordos e caminhada pela malha viária; o planejador direto é o fallback (OTP fora do ar
  // ou ainda não implantado) — degradação graciosa em vez de erro para o usuário.
  return cfg.OTP_URL ? new OtpPlanner(cfg.OTP_URL, deps, direct) : direct;
}
