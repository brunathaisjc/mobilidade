import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodePolyline, type Itinerary, type LngLat, type Place, type TransitLeg } from '@mobigo/shared';
import { api } from '../api/client';
import { useVehicleStream, type StreamStatus } from '../realtime/useVehicleStream';
import { loadBusImage } from './busIcon';
import { VehicleAnimator, busIconId } from './VehicleAnimator';

// Estilo vetorial OSM sem chave de API (OpenFreeMap). Em produção: tiles PMTiles próprios de Goiás (ADR 0003).
const STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';
const GOIANIA: LngLat = [-49.2648, -16.6869];
/**
 * Estilo mínimo usado se o servidor de tiles estiver fora do ar ou bloqueado: sem mapa de fundo,
 * mas rotas, pontos e ônibus continuam visíveis (o essencial para quem está esperando no ponto).
 */
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9edf1' } }],
};
const FRAME_INTERVAL_MS = 1000 / 30;

interface Props {
  itineraries: Itinerary[];
  selectedId: string | null;
  from: Place | null;
  to: Place | null;
  onMapClick?: (p: { lon: number; lat: number }) => void;
  onStatus?: (s: StreamStatus) => void;
}

const empty = { type: 'FeatureCollection' as const, features: [] };
const shapeCache = new Map<string, Promise<LngLat[]>>();
const fetchShape = (id: string) => {
  if (!shapeCache.has(id)) shapeCache.set(id, api.shape(id).then((s) => s.coordinates).catch(() => { shapeCache.delete(id); return []; }));
  return shapeCache.get(id)!;
};

export function MapView({ itineraries, selectedId, from, to, onMapClick, onStatus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const animator = useMemo(() => new VehicleAnimator(), []);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  // ----- inicialização do mapa ------------------------------------------------------------
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE_URL,
      center: GOIANIA,
      zoom: 12,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
    map.on('click', (e) => clickRef.current?.({ lon: e.lngLat.lng, lat: e.lngLat.lat }));
    let usingFallback = false;
    map.on('error', (e) => {
      // Falha ao baixar o estilo/tiles antes do primeiro carregamento → degrada para o estilo local.
      if (!usingFallback && !map.loaded() && !map.isStyleLoaded()) {
        usingFallback = true;
        console.warn('mapa base indisponível, usando estilo de contingência', e.error?.message);
        map.setStyle(FALLBACK_STYLE);
      }
    });
    map.on('load', () => {
      map.addSource('shapes', { type: 'geojson', data: empty });
      map.addSource('legs', { type: 'geojson', data: empty });
      map.addSource('stops', { type: 'geojson', data: empty });
      map.addSource('endpoints', { type: 'geojson', data: empty });
      map.addSource('vehicles', { type: 'geojson', data: empty });
      // Traçado completo da linha (contexto: por onde o ônibus vem)
      map.addLayer({ id: 'shapes', type: 'line', source: 'shapes',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['case', ['get', 'selected'], 0.35, 0.12] } });
      map.addLayer({ id: 'legs-walk', type: 'line', source: 'legs', filter: ['==', ['get', 'mode'], 'WALK'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#57606a', 'line-width': 3, 'line-dasharray': [0.5, 2], 'line-opacity': ['case', ['get', 'selected'], 0.9, 0.3] } });
      map.addLayer({ id: 'legs-bus-casing', type: 'line', source: 'legs', filter: ['==', ['get', 'mode'], 'BUS'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'selected'], 10, 6], 'line-opacity': ['case', ['get', 'selected'], 1, 0.5] } });
      map.addLayer({ id: 'legs-bus', type: 'line', source: 'legs', filter: ['==', ['get', 'mode'], 'BUS'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'selected'], 6, 3.5], 'line-opacity': ['case', ['get', 'selected'], 1, 0.55] } });
      map.addLayer({ id: 'stops', type: 'circle', source: 'stops',
        paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 } });
      // Rótulos exigem fontes (glyphs) do estilo; o estilo de contingência não as tem.
      if (map.getStyle().glyphs) map.addLayer({ id: 'stops-label', type: 'symbol', source: 'stops', minzoom: 13,
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#1f2328', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
      map.addLayer({ id: 'vehicles', type: 'symbol', source: 'vehicles',
        layout: {
          'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 0.7, 16, 0.9],
          'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['get', 'opacity'] } });
      map.addLayer({ id: 'endpoints', type: 'circle', source: 'endpoints',
        paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'kind'], 'origin', '#1a7f37', '#cf222e'],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
      setReady(true);
    });
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ----- origem / destino -----------------------------------------------------------------
  useEffect(() => {
    const src = mapRef.current?.getSource('endpoints') as GeoJSONSource | undefined;
    if (!ready || !src) return;
    src.setData({
      type: 'FeatureCollection',
      features: [from && { kind: 'origin', p: from }, to && { kind: 'destination', p: to }].filter(Boolean).map((e) => ({
        type: 'Feature' as const, properties: { kind: e!.kind }, geometry: { type: 'Point' as const, coordinates: [e!.p.lon, e!.p.lat] },
      })),
    });
  }, [ready, from, to]);

  // ----- itinerários, shapes e ícones ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let cancelled = false;
    const legs: GeoJSON.Feature[] = [];
    const stops: GeoJSON.Feature[] = [];
    const bounds = new maplibregl.LngLatBounds();
    const busLegs: { leg: TransitLeg; color: string; selected: boolean }[] = [];
    for (const it of itineraries) {
      const selected = it.id === selectedId;
      for (const leg of it.legs) {
        const coords = decodePolyline(leg.geometry);
        if (selected || !selectedId) coords.forEach((c) => bounds.extend(c));
        legs.push({ type: 'Feature', properties: { mode: leg.mode, color: it.color, selected },
          geometry: { type: 'LineString', coordinates: coords } });
        if (leg.mode === 'BUS') {
          busLegs.push({ leg, color: it.color, selected });
          for (const s of [leg.board, leg.alight]) {
            stops.push({ type: 'Feature', properties: { name: s.name, color: it.color }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
          }
        }
      }
    }
    // Itinerário selecionado por último = desenhado por cima
    legs.sort((a, b) => Number(a.properties!.selected) - Number(b.properties!.selected));
    (map.getSource('legs') as GeoJSONSource).setData({ type: 'FeatureCollection', features: legs });
    (map.getSource('stops') as GeoJSONSource).setData({ type: 'FeatureCollection', features: stops });
    if (!bounds.isEmpty()) map.fitBounds(bounds as LngLatBoundsLike, { padding: 60, maxZoom: 16, duration: 600 });

    animator.clearShapes();
    Promise.all(busLegs.map(async ({ leg, color, selected }) => {
      const icon = busIconId(color);
      if (!map.hasImage(icon)) {
        const img = await loadBusImage(color);
        if (!map.hasImage(icon)) map.addImage(icon, img, { pixelRatio: 2 });
      }
      const coords = await fetchShape(leg.shapeId);
      return { shapeId: leg.shapeId, coords, color, selected };
    })).then((shapes) => {
      if (cancelled) return;
      // Um shape pode servir mais de um itinerário: a cor do selecionado prevalece.
      shapes.sort((a, b) => Number(a.selected) - Number(b.selected));
      for (const s of shapes) animator.setShape(s.shapeId, s.coords, s.color);
      (map.getSource('shapes') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shapes.map((s) => ({ type: 'Feature', properties: { color: s.color, selected: s.selected },
          geometry: { type: 'LineString', coordinates: s.coords } })),
      });
    });
    return () => { cancelled = true; };
  }, [ready, itineraries, selectedId, animator]);

  // ----- tempo real ------------------------------------------------------------------------
  const routeIds = useMemo(
    () => itineraries.flatMap((it) => it.legs.filter((l): l is TransitLeg => l.mode === 'BUS').map((l) => l.routeId)),
    [itineraries],
  );
  const status = useVehicleStream(routeIds, (updates) => {
    const now = Date.now();
    for (const u of updates) animator.upsert(u, now);
  });
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  // ----- laço de animação (30 fps; pausa com a aba em segundo plano para poupar bateria) -----
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < FRAME_INTERVAL_MS) return;
      last = t;
      (mapRef.current?.getSource('vehicles') as GeoJSONSource | undefined)?.setData(animator.frame());
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, animator]);

  return <div ref={container} className="map" role="region" aria-label="Mapa com as rotas e os ônibus em tempo real" />;
}
