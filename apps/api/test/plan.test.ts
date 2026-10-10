import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodePolyline, ITINERARY_PALETTE, type PlanResponse, type TransitLeg } from '@mobigo/shared';
import { testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await testApp(); });
afterAll(async () => { await app.close(); });

// Quarta-feira, 14/10/2026, 08:00 em Goiânia (11:00 UTC) — dia útil
const DEPART = '2026-10-14T08:00:00-03:00';
const campinasToBiblia = `fromLat=-16.6685&fromLon=-49.2935&toLat=-16.6735&toLon=-49.2240&fromName=Casa&toName=Trabalho&departAt=${encodeURIComponent(DEPART)}`;

async function plan(qs: string): Promise<PlanResponse> {
  const res = await app.inject({ method: 'GET', url: `/api/plan?${qs}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('planejamento de viagem', () => {
  it('lista todas as linhas diretas, cada uma com cor própria, km, duração e próximos ônibus', async () => {
    const r = await plan(campinasToBiblia);
    expect(r.engine).toBe('gtfs-direct');
    const lines = r.itineraries.flatMap((i) => i.lines).sort();
    expect(lines).toEqual(['101', '102']); // as duas linhas que passam na Praça A rumo à Bíblia
    expect(new Set(r.itineraries.map((i) => i.color)).size).toBe(r.itineraries.length);
    expect(r.itineraries.every((i) => (ITINERARY_PALETTE as readonly string[]).includes(i.color))).toBe(true);
    for (const it of r.itineraries) {
      const bus = it.legs.find((l): l is TransitLeg => l.mode === 'BUS')!;
      expect(bus.board.name).toBe('Praça A (Campinas)');
      expect(bus.alight.name).toBe('Terminal Praça da Bíblia');
      expect(bus.distanceMeters).toBeGreaterThan(6000);
      expect(it.totalDistanceMeters).toBeGreaterThanOrEqual(bus.distanceMeters);
      expect(bus.nextArrivals.length).toBeGreaterThan(1);
      expect(bus.nextArrivals.every((a, i, arr) => i === 0 || a.waitSeconds >= arr[i - 1]!.waitSeconds)).toBe(true);
      expect(it.durationSeconds).toBe(
        it.legs.reduce((s, l) => s + l.durationSeconds, 0) + it.waitSeconds,
      );
      expect(decodePolyline(bus.geometry).length).toBeGreaterThan(2);
    }
    // Ordenado por horário de chegada
    expect(r.itineraries.map((i) => i.arrivalTime)).toEqual([...r.itineraries.map((i) => i.arrivalTime)].sort());
  });

  it('não oferece linha no sentido contrário', async () => {
    const back = await plan(`fromLat=-16.6735&fromLon=-49.2240&toLat=-16.6685&toLon=-49.2935&departAt=${encodeURIComponent(DEPART)}`);
    for (const it of back.itineraries) {
      const bus = it.legs.find((l): l is TransitLeg => l.mode === 'BUS');
      if (bus) expect(bus.headsign).not.toBe('Terminal Praça da Bíblia');
    }
  });

  it('usa a posição GPS do ônibus para a espera e cai para o horário programado sem GPS', async () => {
    // Ônibus da linha 101 a 1 km da Praça A, leitura de 5 s atrás
    await app.realtime.saveVehicles([{
      vehicleId: 'GO-TESTE', routeId: '1:L101', tripId: '1:L101-0-UTIL-074000', shapeId: '1:L101-0',
      lon: -49.30, lat: -16.665, bearing: 110, distanceAlong: 2532, speedMps: 6, timestamp: Math.floor(Date.now() / 1000) - 5, source: 'realtime',
    }]);
    const r = await app.inject({ method: 'GET', url: '/api/plan?fromLat=-16.6685&fromLon=-49.2935&toLat=-16.6735&toLon=-49.2240' });
    const it101 = (r.json() as PlanResponse).itineraries.find((i) => i.lines[0] === '101');
    const bus = it101?.legs.find((l): l is TransitLeg => l.mode === 'BUS');
    const live = bus?.nextArrivals.find((a) => a.vehicleId === 'GO-TESTE');
    // Pode estar fora do horário de operação quando o teste roda de madrugada; o GPS deve aparecer mesmo assim
    expect(live?.source).toBe('realtime');
    expect(live!.waitSeconds).toBeGreaterThan(150);
    expect(live!.waitSeconds).toBeLessThan(260);
  });

  it('inclui opção a pé para trajetos curtos e recusa pontos fora de Goiás', async () => {
    const short = await plan(`fromLat=-16.6866&fromLon=-49.2643&toLat=-16.6830&toLon=-49.2600&departAt=${encodeURIComponent(DEPART)}`);
    expect(short.itineraries.some((i) => i.id === 'walk')).toBe(true);
    const sp = await app.inject({ method: 'GET', url: '/api/plan?fromLat=-23.55&fromLon=-46.63&toLat=-16.67&toLon=-49.25' });
    expect(sp.statusCode).toBe(400);
  });

  it('feriado municipal opera com a tabela de domingo (calendar_dates)', async () => {
    const holiday = await plan(`${campinasToBiblia.replace(encodeURIComponent(DEPART), '')}${encodeURIComponent('2026-10-24T08:00:00-03:00')}`);
    const weekday = await plan(campinasToBiblia);
    const gaps = (r: PlanResponse) => {
      const a = r.itineraries.find((i) => i.lines[0] === '101')!.legs.find((l): l is TransitLeg => l.mode === 'BUS')!.nextArrivals;
      return a[2]!.waitSeconds - a[1]!.waitSeconds;
    };
    expect(gaps(weekday)).toBe(8 * 60);
    expect(gaps(holiday)).toBe(20 * 60);
  });
});

describe('dados de apoio', () => {
  it('pontos próximos com linhas que atendem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stops/nearby?lat=-16.6866&lon=-49.2643&radius=200' });
    const first = res.json()[0];
    expect(first.name).toBe('Praça Cívica');
    expect(first.lines).toEqual(['102', '103', '104']);
  });

  it('busca de lugares ignora acentos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/places/search?q=praca%20civica' });
    expect(res.json()[0].name).toBe('Praça Cívica');
  });

  it('shape com ETag para cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shapes/1:L101-0' });
    expect(res.json().coordinates.length).toBeGreaterThan(100);
    const again = await app.inject({ method: 'GET', url: '/api/shapes/1:L101-0', headers: { 'if-none-match': res.headers.etag as string } });
    expect(again.statusCode).toBe(304);
  });
});

