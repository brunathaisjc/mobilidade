const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const km = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatDuration(seconds: number): string {
  const min = Math.max(0, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${km.format(meters / 1000)} km`;
}

export const formatClock = (iso: string | Date) => clock.format(typeof iso === 'string' ? new Date(iso) : iso);

export function formatWait(seconds: number): string {
  if (seconds < 60) return 'chegando';
  return `em ${Math.round(seconds / 60)} min`;
}
