import { formatFcfa, formatInt } from '../lib/format';

export interface Point { label: string; value: number }

/** Courbe des recettes en SVG pur (aucune bibliothèque de graphiques : léger sur Android d'entrée de gamme). */
export function RevenueChart({ points, title }: { points: Point[]; title: string }) {
  const W = 640, H = 220, L = 52, R = 12, T = 12, B = 28;
  const max = Math.max(1, ...points.map((p) => p.value));
  const nice = (() => { const mag = 10 ** Math.floor(Math.log10(max)); const m = [1, 2, 2.5, 5, 10].find((k) => k * mag >= max)!; return m * mag; })();
  const x = (i: number) => L + (points.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z` : '';
  const step = Math.max(1, Math.ceil(points.length / 6));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(nice * t)} y2={y(nice * t)} stroke="var(--c-border)" strokeWidth="1" />
            <text x={L - 6} y={y(nice * t) + 4} textAnchor="end">{formatInt(nice * t)}</text>
          </g>
        ))}
        {area && <path d={area} fill="var(--c-primary-soft)" />}
        {line && <path d={line} fill="none" stroke="var(--c-primary)" strokeWidth="2.5" strokeLinejoin="round" />}
        {points.length <= 31 && points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.value)} r="3" fill="var(--c-primary)"><title>{`${p.label} : ${formatFcfa(p.value)}`}</title></circle>)}
        {points.map((p, i) => (i % step === 0 ? <text key={i} x={x(i)} y={H - 8} textAnchor="middle">{p.label}</text> : null))}
      </svg>
      <figcaption className="sr-only">{title}</figcaption>
    </figure>
  );
}

export function BarList({ rows, format = formatFcfa }: { rows: { label: string; value: number; hint?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div role="list">
      {rows.map((r) => (
        <div className="bar-row" role="listitem" key={r.label}>
          <span>{r.label}{r.hint ? <><br /><span className="muted small">{r.hint}</span></> : null}</span>
          <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></div>
          <strong className="num">{format(r.value)}</strong>
        </div>
      ))}
    </div>
  );
}
