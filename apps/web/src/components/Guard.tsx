import { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@transport/shared';
import { can, mainSpaceFor } from '../lib/nav';
import { useUser } from '../lib/session';
import { PageHead } from './ui';

/** Page affichée pour une URL d'espace non autorisé (l'API répond de toute façon 403 : la règle serveur fait foi). */
export function AccessDenied() {
  const user = useUser();
  return (
    <div className="card" role="alert" style={{ maxWidth: 560 }}>
      <PageHead title="Accès refusé" subtitle="Votre rôle ne donne pas accès à cet espace." />
      <Link className="btn primary" to={mainSpaceFor(user)}>Retour à mon espace</Link>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useUser();
  const loc = useLocation();
  if (!user) return <Navigate to="/connexion" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const user = useUser();
  return can(user, permission) ? <>{children}</> : <AccessDenied />;
}
