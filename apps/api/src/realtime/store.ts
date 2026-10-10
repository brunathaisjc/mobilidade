/**
 * Estado "quente" dos veículos no Redis.
 *
 *   rt:v:{feed}:{vehicle}   → JSON do VehicleUpdate (TTL 5 min: veículo some se parar de reportar)
 *   rt:trip:{feed}:{trip}   → vehicleId (TTL 5 min)
 *   rt:route:{feed}:{route} → ZSET vehicleId por timestamp (índice para "veículos desta linha")
 *   rt:geo:{feed}           → GEO set (consultas por área do mapa)
 *   canal rt:ch:{feed}:{route} → publicação de cada atualização para os gateways SSE
 *
 * Perder o Redis não perde dado crítico: o próximo ciclo do feed GTFS-RT reconstrói tudo em segundos.
 */
import type { Redis } from 'ioredis';
import type { VehicleUpdate } from '@mobigo/shared';
import { MAX_DEAD_RECKONING_S } from '@mobigo/shared';
import { parseRef } from '../lib/ids.js';

export const VEHICLE_TTL_S = MAX_DEAD_RECKONING_S;
export const channelFor = (routeRef: string) => `rt:ch:${routeRef}`;
export const CHANNEL_PATTERN = 'rt:ch:*';

export class RealtimeStore {
  constructor(private readonly redis: Redis) {}

  /** Grava um lote de atualizações em um único pipeline (1 ida ao Redis por ciclo de feed). */
  async saveVehicles(updates: VehicleUpdate[]): Promise<void> {
    if (!updates.length) return;
    const p = this.redis.pipeline();
    for (const u of updates) {
      const route = parseRef(u.routeId);
      if (!route) continue;
      const vehicleKey = `rt:v:${route.feedId}:${u.vehicleId}`;
      const json = JSON.stringify(u);
      p.set(vehicleKey, json, 'EX', VEHICLE_TTL_S);
      p.set(`rt:trip:${u.tripId}`, u.vehicleId, 'EX', VEHICLE_TTL_S);
      p.zadd(`rt:route:${u.routeId}`, u.timestamp, u.vehicleId);
      p.expire(`rt:route:${u.routeId}`, VEHICLE_TTL_S * 2);
      p.geoadd(`rt:geo:${route.feedId}`, u.lon, u.lat, u.vehicleId);
      p.publish(channelFor(u.routeId), json);
    }
    await p.exec();
  }

  /** Veículos com leitura nos últimos VEHICLE_TTL_S segundos para a linha "<feed>:<route>". */
  async vehiclesByRoute(routeRef: string, nowS = Math.floor(Date.now() / 1000)): Promise<VehicleUpdate[]> {
    const route = parseRef(routeRef);
    if (!route) return [];
    const key = `rt:route:${routeRef}`;
    await this.redis.zremrangebyscore(key, '-inf', nowS - VEHICLE_TTL_S);
    const ids = await this.redis.zrange(key, '0', '-1');
    if (!ids.length) return [];
    const raw = await this.redis.mget(ids.map((id) => `rt:v:${route.feedId}:${id}`));
    return raw
      .filter((r): r is string => r !== null)
      .map((r) => JSON.parse(r) as VehicleUpdate)
      // O veículo pode ter trocado de linha; o ZSET antigo ainda o listaria até expirar.
      .filter((v) => v.routeId === routeRef);
  }

  async vehiclesByRoutes(routeRefs: string[]): Promise<VehicleUpdate[]> {
    const lists = await Promise.all(routeRefs.map((r) => this.vehiclesByRoute(r)));
    return lists.flat();
  }
}
