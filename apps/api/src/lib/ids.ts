/**
 * IDs expostos pela API são prefixados pelo feed ("<feedId>:<id>") porque o mesmo route_id pode
 * existir em feeds diferentes (ex.: linha "101" em Goiânia e em Anápolis).
 */
export const ref = (feedId: number, id: string) => `${feedId}:${id}`;

export function parseRef(value: string): { feedId: number; id: string } | null {
  const i = value.indexOf(':');
  if (i <= 0) return null;
  const feedId = Number(value.slice(0, i));
  const id = value.slice(i + 1);
  return Number.isInteger(feedId) && feedId > 0 && id ? { feedId, id } : null;
}
