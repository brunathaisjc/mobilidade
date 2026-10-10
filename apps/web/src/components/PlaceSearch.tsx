import { useEffect, useId, useState } from 'react';
import type { Place } from '@mobigo/shared';
import { api, type PlaceResult } from '../api/client';
import { useDebounced } from '../hooks';

interface Props {
  label: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  allowMyLocation?: boolean;
}

/** Campo de busca com autocompletar acessível (padrão combobox WAI-ARIA). */
export function PlaceSearch({ label, value, onChange, allowMyLocation }: Props) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [locating, setLocating] = useState(false);
  const q = useDebounced(text, 250);

  useEffect(() => { setText(value?.name ?? ''); }, [value]);

  useEffect(() => {
    if (q.trim().length < 2 || q === value?.name) { setResults([]); return; }
    let alive = true;
    api.searchPlaces(q).then((r) => { if (alive) { setResults(r); setOpen(true); setActive(-1); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [q, value?.name]);

  const pick = (r: PlaceResult) => {
    onChange({ name: r.name, lon: r.lon, lat: r.lat });
    setOpen(false);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); onChange({ name: 'Minha localização', lon: pos.coords.longitude, lat: pos.coords.latitude }); },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="place-search">
      <label htmlFor={id}>{label}</label>
      <div className="place-search__row">
        <input
          id={id}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder="Endereço, ponto ou terminal"
          value={text}
          onChange={(e) => { setText(e.target.value); if (!e.target.value) onChange(null); }}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter' && active >= 0 && results[active]) { e.preventDefault(); pick(results[active]!); }
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        {allowMyLocation && (
          <button type="button" className="icon-btn" onClick={useMyLocation} aria-label="Usar minha localização" disabled={locating}>
            {locating ? '…' : '◎'}
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="place-search__list">
          {results.map((r, i) => (
            <li key={r.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
              className={i === active ? 'active' : undefined} onMouseDown={() => pick(r)}>
              <strong>{r.name}</strong>
              <small>{r.detail}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
