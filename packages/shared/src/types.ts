/** Contratos da API compartilhados entre servidor e cliente web. */
import type { EtaSource } from './eta.js';
import type { LngLat } from './geo.js';

export interface Place {
  name: string;
  lon: number;
  lat: number;
}

export interface StopRef extends Place {
  stopId: string;
  /** Distância do ponto ao longo do shape da linha, em metros. */
  distanceAlong: number;
}

export interface Arrival {
  tripId: string;
  vehicleId: string | null;
  /** Segundos até o ônibus chegar ao ponto de embarque (tempo de espera). */
  waitSeconds: number;
  /** Horário previsto de chegada ao ponto de embarque (ISO 8601). */
  arrivalTime: string;
  /** Horário programado no GTFS, quando conhecido (ISO 8601). */
  scheduledTime: string | null;
  source: EtaSource;
}

export interface WalkLeg {
  mode: 'WALK';
  from: Place;
  to: Place;
  distanceMeters: number;
  durationSeconds: number;
  /** Polyline codificada (precisão 5). */
  geometry: string;
}

export interface TransitLeg {
  mode: 'BUS';
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  headsign: string;
  shapeId: string;
  board: StopRef;
  alight: StopRef;
  stopsCount: number;
  distanceMeters: number;
  /** Tempo dentro do veículo. */
  durationSeconds: number;
  /** Trecho embarcado do shape (polyline codificada). */
  geometry: string;
  /** Próximos ônibus desta linha no ponto de embarque, em ordem de chegada. */
  nextArrivals: Arrival[];
}

export type Leg = WalkLeg | TransitLeg;

export interface Itinerary {
  id: string;
  color: string;
  dashed: boolean;
  legs: Leg[];
  lines: string[];
  totalDistanceMeters: number;
  walkDistanceMeters: number;
  /** Espera pelo primeiro ônibus disponível. */
  waitSeconds: number;
  /** Duração total: caminhada + espera + viagem. */
  durationSeconds: number;
  departureTime: string;
  arrivalTime: string;
  /** true se a previsão do primeiro ônibus vem de GPS (realtime/estimated). */
  realtime: boolean;
}

export interface PlanRequest {
  from: Place;
  to: Place;
  /** ISO 8601; padrão: agora. */
  departAt?: string;
  maxWalkMeters?: number;
}

export interface PlanResponse {
  itineraries: Itinerary[];
  generatedAt: string;
  engine: 'otp' | 'gtfs-direct';
}

export interface VehicleUpdate {
  vehicleId: string;
  routeId: string;
  tripId: string;
  shapeId: string;
  lon: number;
  lat: number;
  bearing: number;
  distanceAlong: number;
  speedMps: number;
  /** Epoch em segundos da leitura de GPS. */
  timestamp: number;
  source: EtaSource;
}

export interface ShapeDto {
  shapeId: string;
  coordinates: LngLat[];
}
