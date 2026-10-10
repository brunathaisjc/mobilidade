import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type SavedRoute } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { POINT_LABEL } from '../components/SaveRouteDialog';
import { planLink } from './SavedRoutesPage';

export function SharedRoutePage() {
  const { token = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<{ sharedBy: string; route: Pick<SavedRoute, 'name' | 'points'> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.shared(token).then(setData).catch((err) => setError(err instanceof ApiError && err.status === 404
      ? 'Este link expirou ou foi desativado por quem compartilhou.' : 'Não foi possível abrir a rota.'));
  }, [token]);

  if (error) return <main className="page"><p className="error" role="alert">{error}</p><Link to="/">Planejar uma viagem</Link></main>;
  if (!data) return <main className="page"><p className="muted">Carregando…</p></main>;
  return (
    <main className="page">
      <p className="muted">{data.sharedBy} compartilhou uma rota com você</p>
      <h1>{data.route.name}</h1>
      <ol className="points card">
        {data.route.points.map((p, i) => (
          <li key={i} className="point">
            <span className={`point__kind point__kind--${p.kind}`}>{POINT_LABEL[p.kind]}</span>
            <span className="point__name">{p.displayName}</span>
          </li>
        ))}
      </ol>
      <p>
        <Link className="btn" to={planLink(data.route as SavedRoute)}>Ver ônibus em tempo real</Link>{' '}
        {user ? (
          <button className="btn btn--secondary" disabled={copied} onClick={async () => { await api.copyShared(token); setCopied(true); }}>
            {copied ? 'Salva nas suas rotas ✓' : 'Salvar nas minhas rotas'}
          </button>
        ) : (
          <button className="btn btn--secondary" onClick={() => navigate('/entrar', { state: { next: `/r/${token}` } })}>Entrar para salvar</button>
        )}
      </p>
    </main>
  );
}
