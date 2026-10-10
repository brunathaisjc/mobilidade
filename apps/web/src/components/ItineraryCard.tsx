import type { Arrival, Itinerary, TransitLeg } from '@mobigo/shared';
import { formatClock, formatDistance, formatDuration, formatWait } from '../format';

const SOURCE_LABEL: Record<Arrival['source'], string> = {
  realtime: 'ao vivo',
  estimated: 'estimado (sem sinal de GPS)',
  scheduled: 'programado',
};

interface Props {
  itinerary: Itinerary;
  selected: boolean;
  /** Segundos decorridos desde que o plano foi gerado (contagem regressiva local). */
  elapsed: number;
  onSelect: () => void;
  onSave?: () => void;
}

export function ItineraryCard({ itinerary: it, selected, elapsed, onSelect, onSave }: Props) {
  const buses = it.legs.filter((l): l is TransitLeg => l.mode === 'BUS');
  const remainingWait = Math.max(0, it.waitSeconds - elapsed);
  return (
    <article
      className={`itinerary${selected ? ' itinerary--selected' : ''}`}
      style={{ ['--it-color' as string]: it.color }}
      aria-current={selected}
    >
      <button type="button" className="itinerary__main" onClick={onSelect} aria-expanded={selected}>
        <span className="itinerary__swatch" aria-hidden="true" style={{ background: it.color, borderStyle: it.dashed ? 'dashed' : 'solid' }} />
        <span className="itinerary__lines">
          {buses.length === 0 && <span className="chip chip--walk">A pé</span>}
          {buses.map((b, i) => (
            <span key={i} className="chip" style={{ background: it.color }} title={b.routeLongName}>{b.routeShortName}</span>
          ))}
        </span>
        <span className="itinerary__time">
          <strong>{formatDuration(it.durationSeconds)}</strong>
          <small>chega {formatClock(it.arrivalTime)}</small>
        </span>
      </button>
      <dl className="itinerary__facts">
        <div><dt>Distância</dt><dd>{formatDistance(it.totalDistanceMeters)}</dd></div>
        <div><dt>Caminhada</dt><dd>{formatDistance(it.walkDistanceMeters)}</dd></div>
        {buses.length > 0 && <div><dt>Espera no ponto</dt><dd>{formatDuration(remainingWait)}</dd></div>}
      </dl>

      {selected && (
        <div className="itinerary__details">
          {it.legs.map((leg, i) => leg.mode === 'WALK' ? (leg.distanceMeters < 20 ? null : (
            <p key={i} className="leg leg--walk">🚶 Caminhe {formatDistance(leg.distanceMeters)} ({formatDuration(leg.durationSeconds)}) até <strong>{leg.to.name}</strong></p>
          )) : (
            <div key={i} className="leg leg--bus">
              <p>
                <span className="chip" style={{ background: it.color }}>{leg.routeShortName}</span>{' '}
                <strong>{leg.routeLongName}</strong> sentido {leg.headsign}
              </p>
              <p>Embarque em <strong>{leg.board.name}</strong> · desça em <strong>{leg.alight.name}</strong></p>
              <p className="muted">{leg.stopsCount} paradas · {formatDistance(leg.distanceMeters)} · {formatDuration(leg.durationSeconds)} a bordo</p>
              <h4>Próximos ônibus neste ponto</h4>
              <ul className="arrivals" aria-live="polite">
                {leg.nextArrivals.map((a, j) => {
                  const wait = Math.max(0, a.waitSeconds - elapsed);
                  return (
                    <li key={`${a.tripId}-${a.vehicleId}-${j}`} className={`arrival arrival--${a.source}`}>
                      <span className="arrival__wait">{formatWait(wait)}</span>
                      <span className="arrival__clock">{formatClock(a.arrivalTime)}</span>
                      <span className="arrival__source">{SOURCE_LABEL[a.source]}</span>
                      {a.vehicleId && <span className="arrival__vehicle">nº {a.vehicleId}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {onSave && <button type="button" className="btn btn--secondary" onClick={onSave}>☆ Salvar esta rota</button>}
        </div>
      )}
    </article>
  );
}
