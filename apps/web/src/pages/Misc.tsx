import { Link } from 'react-router-dom';
import { PageHead } from '../components/ui';
import { mainSpaceFor } from '../lib/nav';
import { useUser } from '../lib/session';

/** Rôle sans espace livré dans cette version (ex. responsable de flotte : module prévu en phase 2). */
export function NoSpace() {
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <PageHead title="Bienvenue" subtitle="Aucun espace n'est encore disponible pour votre rôle dans cette version." />
      <p className="muted">Les espaces Flotte, Personnel, Finance et Rapports détaillés arriveront dans une prochaine phase. Contactez l'administrateur de votre compagnie si vous pensez avoir besoin d'un autre accès.</p>
    </div>
  );
}

export function NotFound() {
  const user = useUser();
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <PageHead title="Page introuvable" subtitle="Cette adresse n'existe pas." />
      <Link className="btn primary" to={mainSpaceFor(user)}>Retour à mon espace</Link>
    </div>
  );
}
