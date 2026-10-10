import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { MUNICIPALITIES } from '../municipalities';

function useAfterAuth() {
  const navigate = useNavigate();
  const location = useLocation();
  const next = (location.state as { next?: string } | null)?.next ?? '/';
  return () => navigate(next, { replace: true });
}

export function LoginPage() {
  const done = useAfterAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth-card">
      <h1>Entrar</h1>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try { await api.login(email, password); done(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Falha ao entrar'); } finally { setBusy(false); }
      }}>
        <label>E-mail<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
      <p>Ainda não tem conta? <Link to="/cadastro">Cadastre-se</Link></p>
    </main>
  );
}

export function RegisterPage() {
  const done = useAfterAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', municipalityIbge: '', acceptTerms: false });
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <main className="auth-card">
      <h1>Criar conta</h1>
      <p className="muted">Gratuito para qualquer pessoa em Goiás. Com a conta você salva rotas, organiza em categorias e compartilha.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null); setIssues({});
        try {
          await api.register({ ...form, municipalityIbge: form.municipalityIbge || undefined });
          done();
        } catch (err) {
          if (err instanceof ApiError) {
            setError(err.message);
            setIssues(Object.fromEntries((err.issues ?? []).map((i) => [i.path, i.message])));
          } else setError('Falha no cadastro');
        } finally { setBusy(false); }
      }}>
        <label>Nome<input autoComplete="name" value={form.name} onChange={set('name')} required minLength={2} maxLength={120} /></label>
        {issues.name && <small className="error">{issues.name}</small>}
        <label>E-mail<input type="email" autoComplete="email" value={form.email} onChange={set('email')} required /></label>
        {issues.email && <small className="error">{issues.email}</small>}
        <label>Senha<input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} aria-describedby="pwd-hint" /></label>
        <small id="pwd-hint" className="muted">Mínimo de 8 caracteres, com letras e números.</small>
        {issues.password && <small className="error">{issues.password}</small>}
        <label>Município onde mora (opcional)
          <select value={form.municipalityIbge} onChange={set('municipalityIbge')}>
            <option value="">Prefiro não informar</option>
            {MUNICIPALITIES.map((m) => <option key={m.ibge} value={m.ibge}>{m.name}</option>)}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.acceptTerms} onChange={set('acceptTerms')} required />
          <span>Li e aceito os <Link to="/termos" target="_blank">Termos de Uso</Link> e a <Link to="/privacidade" target="_blank">Política de Privacidade</Link>.</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Criando…' : 'Criar conta'}</button>
      </form>
      <p>Já tem conta? <Link to="/entrar">Entrar</Link></p>
    </main>
  );
}
