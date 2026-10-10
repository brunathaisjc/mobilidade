/**
 * Relógio do "dia de serviço" GTFS. Goiás usa America/Sao_Paulo (UTC−3, sem horário de verão desde 2019),
 * mas o fuso vem do feed para suportar outros sistemas.
 */
export interface ServiceClock {
  /** Data local 'YYYY-MM-DD'. */
  date: string;
  /** Segundos desde a meia-noite local. */
  seconds: number;
  /** 0 = domingo ... 6 = sábado */
  dow: number;
  /** Epoch (s) correspondente à meia-noite local de `date`. */
  midnightEpoch: number;
}

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const dowColumn = (dow: number) => DOW[dow]!;

export function serviceClock(at: Date, timeZone = 'America/Sao_Paulo'): ServiceClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', weekday: 'short',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { date, seconds, dow, midnightEpoch: Math.floor(at.getTime() / 1000) - seconds };
}

/** Dia de serviço anterior, com os segundos deslocados em +24h (viagens que cruzam a meia-noite). */
export function previousServiceDay(c: ServiceClock, timeZone = 'America/Sao_Paulo'): ServiceClock {
  const prev = serviceClock(new Date((c.midnightEpoch - 12 * 3600) * 1000), timeZone);
  return { date: prev.date, dow: prev.dow, seconds: c.seconds + 86_400, midnightEpoch: c.midnightEpoch - 86_400 };
}

export const ACTIVE_SERVICES_SQL = (dowCol: string) => `
  SELECT service_id FROM gtfs_calendar
   WHERE feed_id = $1 AND $2::date BETWEEN start_date AND end_date AND ${dowCol}
  UNION
  SELECT service_id FROM gtfs_calendar_dates WHERE feed_id = $1 AND date = $2::date AND exception_type = 1
  EXCEPT
  SELECT service_id FROM gtfs_calendar_dates WHERE feed_id = $1 AND date = $2::date AND exception_type = 2`;
