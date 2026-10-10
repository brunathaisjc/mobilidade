/**
 * Teste de carga (k6): consulta de rotas no horário de pico + conexões de tempo real.
 *
 *   k6 run -e BASE_URL=https://homologacao.mobigo.example tests/load/plan-and-stream.k6.js
 *
 * Critérios de aceite (RNF-01, RNF-03): p95 de /api/plan < 400 ms, erros < 0,5%.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

// Pares origem/destino em Goiânia (amostra sintética); em homologação, use pares reais de demanda.
const PAIRS = [
  [-16.6685, -49.2935, -16.6735, -49.2240],
  [-16.7065, -49.2560, -16.6035, -49.2654],
  [-16.7105, -49.2370, -16.6680, -49.2930],
  [-16.7150, -49.2975, -16.6788, -49.2556],
];

export const options = {
  scenarios: {
    pico_consultas: {
      executor: 'ramping-arrival-rate',
      startRate: 10, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 1000,
      stages: [
        { target: 100, duration: '2m' }, // ~6.000 consultas/min (pico estimado)
        { target: 100, duration: '5m' },
        { target: 0, duration: '1m' },
      ],
    },
  },
  thresholds: {
    'http_req_duration{name:plan}': ['p(95)<400'],
    http_req_failed: ['rate<0.005'],
  },
};

export default function () {
  const [fLat, fLon, tLat, tLon] = PAIRS[Math.floor(Math.random() * PAIRS.length)];
  const jitter = () => (Math.random() - 0.5) * 0.004; // ~±200 m
  const res = http.get(
    `${BASE}/api/plan?fromLat=${fLat + jitter()}&fromLon=${fLon + jitter()}&toLat=${tLat + jitter()}&toLon=${tLon + jitter()}`,
    { tags: { name: 'plan' } },
  );
  check(res, { 'status 200': (r) => r.status === 200, 'tem itinerários': (r) => r.json('itineraries.length') > 0 });
  sleep(1);
}
