import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { api, type User } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { PrivacyPage, TermsPage } from './pages/LegalPages';
import { PlanPage } from './pages/PlanPage';
import { Avatar, ProfilePage } from './pages/ProfilePage';
import { SavedRoutesPage } from './pages/SavedRoutesPage';
import { SharedRoutePage } from './pages/SharedRoutePage';

function RequireAuth({ children }: { children: (user: User) => ReactElement }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><p className="muted">Carregando…</p></main>;
  if (!user) return <Navigate to="/entrar" replace state={{ next: location.pathname }} />;
  return children(user);
}

function Header() {
  const { user } = useAuth();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="Mobi GO — início">
        <img src="/favicon.svg" alt="" width={28} height={28} /> <span>Mobi GO</span>
      </Link>
      <nav aria-label="Principal">
        <NavLink to="/" end>Planejar</NavLink>
        {user && <NavLink to="/rotas">Minhas rotas</NavLink>}
      </nav>
      <div className="topbar__user">
        {user ? (
          <>
            <NavLink to="/perfil" className="user-link" aria-label="Meu perfil"><Avatar user={user} size={32} /><span>{user.name.split(' ')[0]}</span></NavLink>
            <button className="link" onClick={() => api.logout()}>Sair</button>
          </>
        ) : (
          <>
            <NavLink to="/entrar">Entrar</NavLink>
            <NavLink to="/cadastro" className="btn btn--small">Criar conta</NavLink>
          </>
        )}
      </div>
    </header>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
        <Header />
        <div id="conteudo" className="content">
          <Routes>
            <Route path="/" element={<PlanPage />} />
            <Route path="/entrar" element={<LoginPage />} />
            <Route path="/cadastro" element={<RegisterPage />} />
            <Route path="/r/:token" element={<SharedRoutePage />} />
            <Route path="/rotas" element={<RequireAuth>{() => <SavedRoutesPage />}</RequireAuth>} />
            <Route path="/perfil" element={<RequireAuth>{(u) => <ProfilePage user={u} />}</RequireAuth>} />
            <Route path="/privacidade" element={<PrivacyPage />} />
            <Route path="/termos" element={<TermsPage />} />
            <Route path="*" element={<main className="page"><h1>Página não encontrada</h1><Link to="/">Voltar ao início</Link></main>} />
          </Routes>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
