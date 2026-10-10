import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onSessionChange, refreshSession, type User } from '../api/client';

interface AuthState {
  user: User | null;
  /** true até a primeira tentativa de restaurar a sessão terminar */
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });
  useEffect(() => {
    const off = onSessionChange((user) => setState({ user, loading: false }));
    // Restaura a sessão a partir do cookie httpOnly (se houver).
    refreshSession().then((ok) => { if (!ok) setState({ user: null, loading: false }); });
    return () => { off(); };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
