import { useEffect, useRef, useState } from 'react';
import type { Itinerary, Place, TransitLeg } from '@mobigo/shared';
import { api, ApiError, type Category, type RoutePoint } from '../api/client';

interface Props {
  itinerary: Itinerary;
  from: Place;
  to: Place;
  onClose: (saved: boolean) => void;
}

/** Monta os pontos da rota (origem, embarques/desembarques, destino) a partir do itinerário. */
export function pointsFromItinerary(it: Itinerary, from: Place, to: Place): RoutePoint[] {
  const points: RoutePoint[] = [{ kind: 'origin', lon: from.lon, lat: from.lat, originalName: from.name }];
  for (const leg of it.legs.filter((l): l is TransitLeg => l.mode === 'BUS')) {
    points.push({ kind: 'board', stopId: leg.board.stopId, lon: leg.board.lon, lat: leg.board.lat, originalName: leg.board.name });
    points.push({ kind: 'alight', stopId: leg.alight.stopId, lon: leg.alight.lon, lat: leg.alight.lat, originalName: leg.alight.name });
  }
  points.push({ kind: 'destination', lon: to.lon, lat: to.lat, originalName: to.name });
  return points;
}

export const POINT_LABEL: Record<RoutePoint['kind'], string> = {
  origin: 'Origem', board: 'Embarque', alight: 'Desembarque', waypoint: 'Parada', destination: 'Destino',
};

export function SaveRouteDialog({ itinerary, from, to, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState(`${from.name} → ${to.name}`.slice(0, 80));
  const [categoryId, setCategoryId] = useState<string>('');
  const [newCategory, setNewCategory] = useState('');
  const [points, setPoints] = useState(() => pointsFromItinerary(itinerary, from, to));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
    api.categories().then(setCategories).catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let catId: string | null = categoryId && categoryId !== '__new' ? categoryId : null;
      if (categoryId === '__new' && newCategory.trim()) catId = (await api.createCategory({ name: newCategory.trim() })).id;
      const routeIds = itinerary.legs.filter((l): l is TransitLeg => l.mode === 'BUS').map((l) => l.routeId);
      await api.saveRoute({
        name, categoryId: catId, preferredRouteIds: routeIds,
        points: points.map((p) => ({ ...p, customName: p.customName?.trim() || null })),
      });
      dialog.current?.close();
      onClose(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog" onCancel={() => onClose(false)} aria-labelledby="save-title">
      <form onSubmit={submit}>
        <h2 id="save-title">Salvar rota</h2>
        <label>Nome da rota
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label>Categoria
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sem categoria</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new">+ Nova categoria…</option>
          </select>
        </label>
        {categoryId === '__new' && (
          <label>Nome da nova categoria
            <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} maxLength={40} placeholder="Ex.: Trabalho, Faculdade, Família" required />
          </label>
        )}
        <fieldset>
          <legend>Dê nomes aos pontos (opcional)</legend>
          {points.map((p, i) => (
            <label key={i} className="point-name">
              <span>{POINT_LABEL[p.kind]} · <small>{p.originalName}</small></span>
              <input
                value={p.customName ?? ''}
                maxLength={60}
                placeholder={p.kind === 'origin' ? 'Ex.: Casa' : p.kind === 'destination' ? 'Ex.: Trabalho' : 'Ex.: Ponto da padaria'}
                onChange={(e) => setPoints((ps) => ps.map((x, j) => (j === i ? { ...x, customName: e.target.value } : x)))}
              />
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={() => { dialog.current?.close(); onClose(false); }}>Cancelar</button>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </dialog>
  );
}
