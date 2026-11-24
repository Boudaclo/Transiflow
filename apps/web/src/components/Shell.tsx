import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { APP_NAME } from '../config';
import { useCompany } from '../lib/company';
import { roleLabel } from '../lib/labels';
import { can, visibleSpaces } from '../lib/nav';
import { initials } from '../lib/format';
import { logout, useUser } from '../lib/session';
import { Icon } from './Icon';
import { StatusBanner, useNetSummary } from './StatusBanner';

function Brand() {
  const company = useCompany();
  return (
    <div className="brand">
      {company?.logo ? <img src={company.logo} alt="" /> : <span className="logo-mark" aria-hidden="true"><Icon name="bus" size={20} /></span>}
      <span>{APP_NAME}{company ? <><br /><small style={{ fontWeight: 400, opacity: 0.8, fontSize: '0.75rem' }}>{company.name}</small></> : null}</span>
    </div>
  );
}

function Notifications() {
  const n = useNetSummary();
  const [open, setOpen] = useState(false);
  const count = n.pending + n.anomalies + n.rejected;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="icon-btn" aria-label={`Notifications${count ? ` (${count})` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {count > 0 && <span className="badge danger" style={{ position: 'absolute', top: 0, right: 0, padding: '0 6px' }}>{count}</span>}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <p className="small" style={{ padding: 'var(--sp-2)' }}>{n.online ? 'Réseau disponible.' : 'Pas de réseau : vos ventes et validations sont gardées sur cet appareil.'}</p>
          {n.pending > 0 && <p className="small" style={{ padding: 'var(--sp-2)' }}>{n.pending} élément(s) en attente d'envoi.</p>}
          {n.anomalies + n.rejected > 0 && <p className="small" style={{ padding: 'var(--sp-2)' }}>{n.anomalies + n.rejected} anomalie(s) signalée(s).</p>}
          {count === 0 && n.online && <p className="small muted" style={{ padding: 'var(--sp-2)' }}>Rien à signaler.</p>}
        </div>
      )}
    </div>
  );
}

function ProfileMenu() {
  const user = useUser()!;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="row" style={{ background: 'none', border: 0, cursor: 'pointer', minHeight: 44 }} aria-expanded={open} aria-label="Menu du profil" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{initials(user.fullName)}</span>
        <span className="who"><span>{user.fullName}</span><span>{user.roles.map(roleLabel).join(', ')}</span></span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <p className="small muted" style={{ padding: 'var(--sp-2)' }}>{user.email}</p>
          <button type="button" role="menuitem" className="btn ghost" onClick={async () => { await logout(); nav('/connexion', { replace: true }); }}><Icon name="logout" size={18} />Se déconnecter</button>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const user = useUser()!;
  const spaces = visibleSpaces(user);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const onSearch = (e: FormEvent) => { e.preventDefault(); if (q.trim()) nav(`/clients?q=${encodeURIComponent(q.trim())}`); };
  return (
    <div className="shell">
      <div className="banner"><StatusBanner /></div>
      <aside className="sidebar">
        <Link to="/" style={{ textDecoration: 'none' }}><Brand /></Link>
        <nav className="nav" aria-label="Espaces">
          {spaces.map((s) => <NavLink key={s.key} to={s.path}><Icon name={s.icon} />{s.label}</NavLink>)}
        </nav>
      </aside>
      <header className="topbar">
        {can(user, 'clients:lire') ? (
          <form className="search grow" role="search" onSubmit={onSearch}>
            <label className="sr-only" htmlFor="gsearch">Rechercher un client</label>
            <input id="gsearch" className="input" type="search" placeholder="Rechercher un client (nom ou téléphone)" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        ) : <span className="grow" />}
        <Notifications />
        <ProfileMenu />
      </header>
      <main className="main" id="contenu"><Outlet /></main>
      <nav className="bottombar" aria-label="Espaces (mobile)">
        {spaces.map((s) => <NavLink key={s.key} to={s.path}><Icon name={s.icon} /><span>{s.label.split(' ')[0]}</span></NavLink>)}
      </nav>
    </div>
  );
}
