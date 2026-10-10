import { colorForIndex, encodePolyline, haversine, type Itinerary, type Place, type WalkLeg } from '@mobigo/shared';

/** Fator de desvio da caminhada em malha urbana (distância real / linha reta). Ver ADR 0004. */
export const WALK_DETOUR = 1.3;
export const WALK_SPEED_MPS = 1.2; // ~4,3 km/h; conservador para incluir idosos e PcD

export function walkLeg(from: Place, to: Place): WalkLeg {
  const distance = Math.round(haversine([from.lon, from.lat], [to.lon, to.lat]) * WALK_DETOUR);
  return {
    mode: 'WALK',
    from,
    to,
    distanceMeters: distance,
    durationSeconds: Math.round(distance / WALK_SPEED_MPS),
    geometry: encodePolyline([[from.lon, from.lat], [to.lon, to.lat]]),
  };
}

/** Ordena por horário de chegada, remove opções dominadas e atribui uma cor distinta a cada itinerário. */
export function rankItineraries(list: Omit<Itinerary, 'color' | 'dashed'>[], max = 8): Itinerary[] {
  return [...list]
    .sort((a, b) => a.arrivalTime.localeCompare(b.arrivalTime) || a.walkDistanceMeters - b.walkDistanceMeters)
    .slice(0, max)
    .map((it, i) => ({ ...it, ...colorForIndex(i) }));
}
