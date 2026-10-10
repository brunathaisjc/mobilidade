import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Place, PlanResponse } from '@mobigo/shared';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ItineraryCard } from '../components/ItineraryCard';
import { PlaceSearch } from '../components/PlaceSearch';
import { SaveRouteDialog } from '../components/SaveRouteDialog';
import { useNow } from '../hooks';
import { MapView } from '../map/MapView';
import type { StreamStatus } from '../realtime/useVehicleStream';

const REFRESH_MS = 30_000;

/** Serialização de um lugar na URL (?from=lat,lon,nome) para links "consultar agora" e compartilhamento. */
export const placeParam = (p: Place) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)},${p.name}`;
function parsePlace(v: string | null): Place | null {
  if (!v) return null;
  const [lat, lon, ...name] = v.split(',');
  const p = { lat: Number(lat), lon: Number(lon), name: name.join(',') || 'Local' };
  return Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  idle: '', live: 'Tempo real conectado', reconnecting: 'Reconectando ao tempo real…', polling: 'Tempo real em modo econômico (atualiza a cada 10 s)',
};

export function PlanPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState<Place | null>(() => parsePlace(params.get('from')));
  const [to, setTo] = useState<Place | null>(() => parsePlace(params.get('to')));
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamStatus>('idle');
  const now = useNow(1000);

  const search = useCallback(async (silent = false) => {
    if (!from || !to) return;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const res = await api.plan({ from, to });
      setPlan(res);
      setSelectedId((id) => (id && res.itineraries.some((i) => i.id === id) ? id : res.itineraries[0]?.id ?? null));
      if (!res.itineraries.length) setError('Nenhuma linha atende este trajeto nas próximas 2 horas. Tente outro ponto próximo.');
    } catch (err) {
      if (!silent) setError(err instanceof ApiError ? err.message : 'Sem conexão. Tente novamente.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [from, to]);

  // Atualiza a URL e consulta quando origem e destino estão definidos
  useEffect(() => {
    const next = new URLSearchParams();
    if (from) next.set('from', placeParam(from));
    if (to) next.set('to', placeParam(to));
    setParams(next, { replace: true });
    if (from && to) search();
    else setPlan(null);
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconsulta periódica (novas previsões), só com a aba visível
  useEffect(() => {
    if (!plan) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') search(true); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [plan, search]);

  const onMapClick = useCallback((p: { lon: number; lat: number }) => {
    const place = { ...p, name: `Ponto no mapa (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})` };
    if (!from) setFrom(place);
    else setTo(place);
  }, [from]);

  const elapsed = plan ? Math.max(0, Math.floor((now - new Date(plan.generatedAt).getTime()) / 1000)) : 0;
  const itineraries = useMemo(() => plan?.itineraries ?? [], [plan]);
  const selected = itineraries.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="plan-layout">
      <section className="panel" aria-label="Planejar viagem">
        <form className="search" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <PlaceSearch label="Origem" value={from} onChange={setFrom} allowMyLocation />
          <button type="button" className="swap" aria-label="Inverter origem e destino" onClick={() => { setFrom(to); setTo(from); }}>⇅</button>
          <PlaceSearch label="Destino" value={to} onChange={setTo} />
          {!from || !to ? <p className="hint">Dica: toque no mapa para marcar {from ? 'o destino' : 'a origem'}.</p> : null}
        </form>

        {loading && <p className="muted" role="status">Buscando linhas…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {savedMsg && <p className="success" role="status">{savedMsg} <Link to="/rotas">Ver minhas rotas</Link></p>}
        {stream !== 'idle' && <p className={`stream stream--${stream}`} role="status">● {STATUS_TEXT[stream]}</p>}

        {itineraries.length > 0 && (
          <>
            <h2 className="results-title">{itineraries.length} {itineraries.length === 1 ? 'opção' : 'opções'} de trajeto</h2>
            <div className="results">
              {itineraries.map((it) => (
                <ItineraryCard
                  key={it.id}
                  itinerary={it}
                  selected={it.id === selectedId}
                  elapsed={elapsed}
                  onSelect={() => setSelectedId(it.id)}
                  onSave={user ? () => setSaving(true) : undefined}
                />
              ))}
            </div>
            {!user && <p className="muted"><Link to="/entrar">Entre</Link> ou <Link to="/cadastro">crie sua conta</Link> para salvar e compartilhar rotas.</p>}
            <p className="muted small">Fonte: {plan?.engine === 'otp' ? 'OpenTripPlanner' : 'linhas diretas (GTFS)'} · atualizado às {plan && new Date(plan.generatedAt).toLocaleTimeString('pt-BR')}</p>
          </>
        )}
      </section>

      <MapView itineraries={itineraries} selectedId={selectedId} from={from} to={to} onMapClick={onMapClick} onStatus={setStream} />

      {saving && selected && from && to && (
        <SaveRouteDialog itinerary={selected} from={from} to={to} onClose={(ok) => {
          setSaving(false);
          if (ok) setSavedMsg('Rota salva!');
        }} />
      )}
    </div>
  );
}
