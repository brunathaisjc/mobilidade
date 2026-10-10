import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Category, type SavedRoute } from '../api/client';
import { POINT_LABEL } from '../components/SaveRouteDialog';
import { placeParam } from './PlanPage';

function planLink(r: Pick<SavedRoute, 'points'>) {
  const o = r.points[0]!;
  const d = r.points[r.points.length - 1]!;
  const q = new URLSearchParams({
    from: placeParam({ lat: o.lat, lon: o.lon, name: o.displayName ?? o.originalName }),
    to: placeParam({ lat: d.lat, lon: d.lon, name: d.displayName ?? d.originalName }),
  });
  return `/?${q}`;
}
export { planLink };

function PointName({ route, point, onSaved }: { route: SavedRoute; point: SavedRoute['points'][number]; onSaved: (r: SavedRoute) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(point.customName ?? '');
  if (!editing) {
    return (
      <li className="point">
        <span className={`point__kind point__kind--${point.kind}`}>{POINT_LABEL[point.kind]}</span>
        <span className="point__name">
          {point.displayName}
          {point.customName && <small className="muted"> ({point.originalName})</small>}
        </span>
        <button className="link" onClick={() => setEditing(true)} aria-label={`Renomear ${point.displayName}`}>renomear</button>
      </li>
    );
  }
  return (
    <li className="point">
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        onSaved(await api.renamePoint(route.id, point.id, value.trim() || null));
        setEditing(false);
      }}>
        <input autoFocus value={value} maxLength={60} placeholder={point.originalName} onChange={(e) => setValue(e.target.value)} aria-label="Nome personalizado" />
        <button className="btn btn--small">OK</button>
        <button type="button" className="link" onClick={() => setEditing(false)}>cancelar</button>
      </form>
    </li>
  );
}

function ShareBox({ route }: { route: SavedRoute }) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const s = await api.createShare(route.id, 90);
    setUrl(s.url);
    if (navigator.share) {
      await navigator.share({ title: route.name, text: `Minha rota de ônibus: ${route.name}`, url: s.url }).catch(() => undefined);
    }
  };
  return (
    <div className="share">
      {!url && <button className="btn btn--secondary btn--small" onClick={share}>Compartilhar</button>}
      {url && (
        <>
          <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Link de compartilhamento" />
          <button className="btn btn--small" onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); }}>{copied ? 'Copiado!' : 'Copiar'}</button>
          <a className="btn btn--small btn--whatsapp" href={`https://wa.me/?text=${encodeURIComponent(`${route.name}: ${url}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
        </>
      )}
    </div>
  );
}

export function SavedRoutesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [routes, setRoutes] = useState<SavedRoute[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [newCat, setNewCat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [c, r] = await Promise.all([api.categories(), api.savedRoutes()]);
    setCategories(c);
    setRoutes(r);
  }, []);
  useEffect(() => { reload().catch(() => setError('Não foi possível carregar suas rotas')); }, [reload]);

  const visible = routes.filter((r) => filter === 'all' || (filter === 'none' ? !r.categoryId : r.categoryId === filter));
  const replace = (r: SavedRoute) => setRoutes((list) => list.map((x) => (x.id === r.id ? r : x)));

  return (
    <main className="page">
      <h1>Minhas rotas</h1>
      <nav className="tabs" aria-label="Categorias">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todas ({routes.length})</button>
        {categories.map((c) => (
          <button key={c.id} className={filter === c.id ? 'active' : ''} onClick={() => setFilter(c.id)} style={{ ['--cat' as string]: c.color }}>
            <span className="dot" style={{ background: c.color }} aria-hidden="true" /> {c.name} ({c.routeCount})
          </button>
        ))}
        <button className={filter === 'none' ? 'active' : ''} onClick={() => setFilter('none')}>Sem categoria</button>
      </nav>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.createCategory({ name: newCat.trim() }); setNewCat(''); await reload(); }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Falha ao criar categoria'); }
      }}>
        <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Nova categoria (ex.: Faculdade)" maxLength={40} aria-label="Nome da nova categoria" />
        <button className="btn btn--small" disabled={!newCat.trim()}>Criar categoria</button>
        {filter !== 'all' && filter !== 'none' && (
          <button type="button" className="link danger" onClick={async () => {
            if (!confirm('Excluir a categoria? As rotas continuam salvas, sem categoria.')) return;
            await api.deleteCategory(filter); setFilter('all'); await reload();
          }}>excluir esta categoria</button>
        )}
      </form>
      {error && <p className="error" role="alert">{error}</p>}

      {visible.length === 0 && <p className="muted">Nenhuma rota aqui ainda. <Link to="/">Planeje uma viagem</Link> e toque em “Salvar esta rota”.</p>}
      <div className="route-list">
        {visible.map((r) => (
          <article key={r.id} className="card route">
            <header>
              <h2>{r.name}</h2>
              <select aria-label="Mover para categoria" value={r.categoryId ?? ''} onChange={async (e) => {
                replace(await api.updateRoute(r.id, { categoryId: e.target.value || null }));
                reload();
              }}>
                <option value="">Sem categoria</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </header>
            <ol className="points">{r.points.map((p) => <PointName key={p.id} route={r} point={p} onSaved={replace} />)}</ol>
            <footer>
              <Link className="btn btn--small" to={planLink(r)}>Ver horários agora</Link>
              <ShareBox route={r} />
              <button className="link danger" onClick={async () => {
                if (!confirm(`Excluir a rota "${r.name}"?`)) return;
                await api.deleteRoute(r.id); reload();
              }}>excluir</button>
            </footer>
          </article>
        ))}
      </div>
    </main>
  );
}
