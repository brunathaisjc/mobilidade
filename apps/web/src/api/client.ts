/**
 * Cliente HTTP da API. O access token fica só em memória (não em localStorage: imune a roubo por XSS
 * persistente); a sessão sobrevive a recarregamentos pelo cookie httpOnly de refresh.
 */
import type { PlanResponse } from '@mobigo/shared';

export interface User {
  id: string;
  name: string;
  email: string;
  municipalityIbge: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Category { id: string; name: string; color: string; icon: string; position: number; routeCount: number }

export interface RoutePoint {
  id?: string;
  seq?: number;
  kind: 'origin' | 'board' | 'alight' | 'waypoint' | 'destination';
  stopId?: string | null;
  lon: number;
  lat: number;
  originalName: string;
  customName?: string | null;
  displayName?: string;
}

export interface SavedRoute {
  id: string;
  name: string;
  categoryId: string | null;
  preferredRouteIds: string[];
  createdAt: string;
  updatedAt: string;
  points: (RoutePoint & { id: string; displayName: string })[];
}

export interface Share { id: string; url: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; active: boolean }
export interface PlaceResult { id: string; name: string; detail: string; lon: number; lat: number; kind: 'stop' | 'address' }

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: { path: string; message: string }[]) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(u: User | null) => void>();

export const onSessionChange = (fn: (u: User | null) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (u: User | null) => listeners.forEach((l) => l(u));

function setSession(body: { user: User; accessToken: string } | null) {
  accessToken = body?.accessToken ?? null;
  emit(body?.user ?? null);
}

/** Renova o access token uma única vez mesmo com várias requisições concorrentes recebendo 401. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) { setSession(null); return false; }
      setSession(await res.json());
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && retry && accessToken && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) return request<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? `Erro ${res.status}`, body.issues);
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  async register(input: { name: string; email: string; password: string; acceptTerms: boolean; municipalityIbge?: string }) {
    const body = await request<{ user: User; accessToken: string }>('/api/auth/register', json('POST', input));
    setSession(body);
    return body.user;
  },
  async login(email: string, password: string) {
    const body = await request<{ user: User; accessToken: string }>('/api/auth/login', json('POST', { email, password }));
    setSession(body);
    return body.user;
  },
  async logout() {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
  },
  me: () => request<User>('/api/me'),
  updateMe: async (input: { name?: string; municipalityIbge?: string | null }) => {
    const user = await request<User>('/api/me', json('PATCH', input));
    emit(user);
    return user;
  },
  async uploadAvatar(file: File) {
    const form = new FormData();
    form.append('file', file);
    const user = await request<User>('/api/me/avatar', { method: 'PUT', body: form });
    emit(user);
    return user;
  },
  async removeAvatar() {
    const user = await request<User>('/api/me/avatar', { method: 'DELETE' });
    emit(user);
    return user;
  },
  exportData: () => request<unknown>('/api/me/export'),
  async deleteAccount() {
    await request('/api/me', { method: 'DELETE' });
    setSession(null);
  },

  plan(params: { from: { lat: number; lon: number; name: string }; to: { lat: number; lon: number; name: string }; departAt?: string }) {
    const q = new URLSearchParams({
      fromLat: String(params.from.lat), fromLon: String(params.from.lon), fromName: params.from.name,
      toLat: String(params.to.lat), toLon: String(params.to.lon), toName: params.to.name,
    });
    if (params.departAt) q.set('departAt', params.departAt);
    return request<PlanResponse>(`/api/plan?${q}`);
  },
  searchPlaces: (q: string, near?: { lat: number; lon: number }) =>
    request<PlaceResult[]>(`/api/places/search?${new URLSearchParams({ q, ...(near ? { lat: String(near.lat), lon: String(near.lon) } : {}) })}`),
  shape: (shapeId: string) => request<{ shapeId: string; coordinates: [number, number][] }>(`/api/shapes/${encodeURIComponent(shapeId)}`),

  categories: () => request<Category[]>('/api/categories'),
  createCategory: (input: { name: string; color?: string }) => request<Category>('/api/categories', json('POST', input)),
  updateCategory: (id: string, input: Partial<Pick<Category, 'name' | 'color' | 'position'>>) => request<Category>(`/api/categories/${id}`, json('PATCH', input)),
  deleteCategory: (id: string) => request<void>(`/api/categories/${id}`, { method: 'DELETE' }),

  savedRoutes: (categoryId?: string) => request<SavedRoute[]>(`/api/saved-routes${categoryId ? `?categoryId=${categoryId}` : ''}`),
  saveRoute: (input: { name: string; categoryId?: string | null; preferredRouteIds: string[]; points: RoutePoint[] }) =>
    request<SavedRoute>('/api/saved-routes', json('POST', input)),
  updateRoute: (id: string, input: { name?: string; categoryId?: string | null }) => request<SavedRoute>(`/api/saved-routes/${id}`, json('PATCH', input)),
  renamePoint: (routeId: string, pointId: string, customName: string | null) =>
    request<SavedRoute>(`/api/saved-routes/${routeId}/points/${pointId}`, json('PATCH', { customName })),
  deleteRoute: (id: string) => request<void>(`/api/saved-routes/${id}`, { method: 'DELETE' }),

  createShare: (routeId: string, expiresInDays?: number) =>
    request<{ id: string; url: string }>(`/api/saved-routes/${routeId}/shares`, json('POST', expiresInDays ? { expiresInDays } : {})),
  shares: (routeId: string) => request<Share[]>(`/api/saved-routes/${routeId}/shares`),
  revokeShare: (shareId: string) => request<void>(`/api/shares/${shareId}`, { method: 'DELETE' }),
  shared: (token: string) => request<{ sharedBy: string; route: Omit<SavedRoute, 'id' | 'categoryId' | 'createdAt' | 'updatedAt'> }>(`/api/shared/${token}`),
  copyShared: (token: string, categoryId?: string | null) => request<SavedRoute>(`/api/shared/${token}/copy`, json('POST', { categoryId })),
};
