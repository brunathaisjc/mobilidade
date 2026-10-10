import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VehicleUpdate } from '@mobigo/shared';
import { parseRef } from '../lib/ids.js';

const HEARTBEAT_MS = 15_000;
const routesQuery = z.object({
  routes: z.string().transform((s) => [...new Set(s.split(',').map((r) => r.trim()).filter(Boolean))])
    .pipe(z.array(z.string().refine((r) => parseRef(r) !== null, 'formato <feedId>:<routeId>')).min(1).max(20)),
});

/**
 * Tempo real via Server-Sent Events (ADR 0005): unidirecional, HTTP comum (passa por proxies, CDN e
 * HTTP/2), reconexão automática pelo navegador. Polling em /vehicles é o fallback.
 */
export async function realtimeRoutes(app: FastifyInstance) {
  // Conexões abertas, para encerrá-las de forma limpa no shutdown (deploy sem conexões penduradas).
  const open = new Set<() => void>();
  app.addHook('onClose', async () => { for (const close of open) close(); });

  app.get('/vehicles', async (req) => {
    const { routes } = routesQuery.parse(req.query);
    return app.realtime.vehiclesByRoutes(routes);
  });

  app.get('/stream', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { routes } = routesQuery.parse(req.query);
    const snapshot = await app.realtime.vehiclesByRoutes(routes);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // inclui CORS definidos pelo plugin
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // desliga buffer do Nginx
    });
    let seq = 0;
    const send = (event: string, data: unknown) => {
      raw.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    raw.write('retry: 3000\n\n');
    send('snapshot', snapshot);

    // Agrupa atualizações em janelas de 500 ms: menos eventos para o cliente, mesma latência percebida.
    let pending = new Map<string, VehicleUpdate>();
    const flush = setInterval(() => {
      if (!pending.size) return;
      send('vehicles', [...pending.values()]);
      pending = new Map();
    }, 500);
    const unsubscribe = app.hub.subscribe(routes, (u) => pending.set(u.vehicleId, u));
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);

    const close = () => {
      if (!open.delete(close)) return;
      clearInterval(flush);
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };
    open.add(close);
    req.raw.on('close', close);
  });
}
