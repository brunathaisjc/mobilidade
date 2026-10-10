import { useEffect, useRef, useState } from 'react';
import type { VehicleUpdate } from '@mobigo/shared';

export type StreamStatus = 'idle' | 'live' | 'reconnecting' | 'polling';

/**
 * Assina as posições dos ônibus das linhas informadas via SSE, com fallback para polling
 * quando a rede/proxy não sustenta conexões longas (ex.: algumas redes corporativas e Wi-Fi público).
 */
export function useVehicleStream(routeIds: string[], onUpdates: (u: VehicleUpdate[]) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const handler = useRef(onUpdates);
  handler.current = onUpdates;
  const key = [...new Set(routeIds)].sort().join(',');

  useEffect(() => {
    if (!key) { setStatus('idle'); return; }
    let poll: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    const es = new EventSource(`/api/realtime/stream?routes=${encodeURIComponent(key)}`);
    const parse = (e: MessageEvent) => { try { handler.current(JSON.parse(e.data)); } catch { /* evento malformado */ } };
    es.addEventListener('snapshot', (e) => { failures = 0; setStatus('live'); parse(e as MessageEvent); });
    es.addEventListener('vehicles', (e) => { failures = 0; setStatus('live'); parse(e as MessageEvent); });
    es.onerror = () => {
      failures++;
      setStatus('reconnecting');
      if (failures >= 3 && !poll) {
        es.close();
        setStatus('polling');
        const tick = () => fetch(`/api/realtime/vehicles?routes=${encodeURIComponent(key)}`)
          .then((r) => (r.ok ? r.json() : []))
          .then((list: VehicleUpdate[]) => handler.current(list))
          .catch(() => undefined);
        tick();
        poll = setInterval(tick, 10_000);
      }
    };
    return () => { es.close(); if (poll) clearInterval(poll); };
  }, [key]);

  return status;
}
