import { ButtonHTMLAttributes, ReactNode, useEffect, useId, useRef } from 'react';
import { Icon, IconName } from './Icon';

type Variant = 'primary' | 'danger' | 'ghost' | 'default';
export function Button({ variant = 'default', big, sm, icon, children, className = '', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean; sm?: boolean; icon?: IconName }) {
  const cls = ['btn', variant !== 'default' ? variant : '', big ? 'big' : '', sm ? 'sm' : '', className].filter(Boolean).join(' ');
  return <button type="button" {...rest} className={cls}>{icon && <Icon name={icon} size={sm ? 18 : 22} />}{children}</button>;
}

export function Field({ label, error, help, children }: { label: string; error?: string | undefined; help?: string; children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const note = error ? `${id}-e` : help ? `${id}-h` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { 'aria-invalid': true as const } : {}), ...(note ? { 'aria-describedby': note } : {}) })}
      {error ? <span id={`${id}-e`} className="err" role="alert">{error}</span> : help ? <span id={`${id}-h`} className="help">{help}</span> : null}
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
const TONE_ICON: Record<Tone, IconName | null> = { ok: 'check', warn: 'clock', danger: 'x', info: null, neutral: null };
/** Badge de statut : couleur + icône + texte (la couleur ne porte jamais l'information seule). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const icon = TONE_ICON[tone];
  return <span className={`badge ${tone}`}>{icon && <Icon name={icon} size={14} />}{children}</span>;
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Alert({ tone = 'error', children, action }: { tone?: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const icon: IconName = tone === 'ok' ? 'check' : tone === 'info' ? 'bell' : 'alert';
  return (
    <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} size={20} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return <div className="loading" role="status"><Icon name="refresh" className="spin" />{label}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children ? <span>{children}</span> : null}{action}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Alert tone="error" action={onRetry ? <Button sm onClick={onRetry} icon="refresh">Réessayer</Button> : undefined}>{message}</Alert>;
}

export interface Column<T> { key: string; header: string; render: (row: T) => ReactNode; align?: 'r'; className?: string }
/** Tableau sur ordinateur, cartes empilées sur téléphone (les libellés viennent de data-label). */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="rt">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={c.align}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key} data-label={c.header} className={[c.align, c.className].filter(Boolean).join(' ')}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return total ? <div className="pager muted small">{total} résultat{total > 1 ? 's' : ''}</div> : null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted small">{from}–{to} sur {total}</span>
      <div className="row">
        <Button sm disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Précédent</Button>
        <Button sm disabled={to >= total} onClick={() => onChange(offset + limit)}>Suivant</Button>
      </div>
    </nav>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row between" style={{ marginBottom: 'var(--sp-4)' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Fermer" onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}
