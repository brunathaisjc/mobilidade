/**
 * Distribuição de atualizações em tempo real para as conexões SSE desta instância da API.
 *
 * Uma única conexão Redis em PSUBSCRIBE por processo, com fan-out em memória: 10 mil clientes
 * conectados não viram 10 mil conexões no Redis. Cada instância recebe todas as atualizações do
 * estado (~1.500 msg/s × ~300 B ≈ 450 KB/s no pico estimado), custo trivial.
 */
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { VehicleUpdate } from '@mobigo/shared';
import { CHANNEL_PATTERN } from './store.js';

type Listener = (u: VehicleUpdate) => void;

export class RealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private started = false;

  constructor(private readonly sub: Redis, private readonly log: FastifyBaseLogger) {}

  async start() {
    if (this.started) return;
    this.started = true;
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const routeRef = channel.slice('rt:ch:'.length);
      const set = this.listeners.get(routeRef);
      if (!set?.size) return;
      let update: VehicleUpdate;
      try {
        update = JSON.parse(message);
      } catch {
        return;
      }
      for (const l of set) l(update);
    });
    this.sub.on('error', (err) => this.log.warn({ err }, 'redis subscriber error'));
    await this.sub.psubscribe(CHANNEL_PATTERN);
  }

  subscribe(routeRefs: string[], listener: Listener): () => void {
    for (const r of routeRefs) {
      if (!this.listeners.has(r)) this.listeners.set(r, new Set());
      this.listeners.get(r)!.add(listener);
    }
    return () => {
      for (const r of routeRefs) {
        const set = this.listeners.get(r);
        set?.delete(listener);
        if (set && !set.size) this.listeners.delete(r);
      }
    };
  }

  get connectionCount() {
    const all = new Set<Listener>();
    for (const s of this.listeners.values()) for (const l of s) all.add(l);
    return all.size;
  }

  async stop() {
    this.listeners.clear();
    if (this.started) this.sub.disconnect();
  }
}
