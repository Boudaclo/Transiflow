import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, errorMessage } from '../lib/api';
import { APP_NAME, APP_TAGLINE } from '../config';
import { Icon } from '../components/Icon';
import { Alert, Button, Field } from '../components/ui';
import { mainSpaceFor } from '../lib/nav';
import { login, useUser } from '../lib/session';

export function LoginPage() {
  const user = useUser();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [locked, setLocked] = useState(false);
  const [help, setHelp] = useState<'oublie' | 'contact' | null>(null);
  if (user) return <Navigate to={mainSpaceFor(user)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined); setLocked(false); setBusy(true);
    try {
      const u = await login(email.trim(), password);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from && from !== '/' ? from : mainSpaceFor(u), { replace: true });
    } catch (err) {
      setLocked(err instanceof ApiError && err.status === 423);
      setError(err instanceof ApiError && err.status === 401 ? 'Email ou mot de passe incorrect.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="card">
        <div className="brand"><span className="logo-mark" aria-hidden="true" style={{ color: '#fff' }}><Icon name="bus" size={20} /></span><span>{APP_NAME}</span></div>
        <h1 style={{ fontSize: '1.35rem' }}>Connexion</h1>
        <p className="muted" style={{ margin: 'var(--sp-1) 0 var(--sp-4)' }}>{APP_TAGLINE}</p>
        <form className="stack" onSubmit={submit} noValidate>
          {error && <Alert tone="error">{locked ? <strong>Compte verrouillé. </strong> : null}{error}</Alert>}
          <Field label="Adresse email">
            {(p) => <input {...p} className="input" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Mot de passe">
            {(p) => (
              <div className="input-wrap">
                <input {...p} className="input" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="icon-btn" aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed={show} onClick={() => setShow((s) => !s)}>
                  <Icon name={show ? 'eye-off' : 'eye'} />
                </button>
              </div>
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !email || !password}>{busy ? 'Connexion…' : 'Se connecter'}</Button>
          <div className="row between small">
            <button type="button" className="btn ghost sm" onClick={() => setHelp('oublie')}>Mot de passe oublié</button>
            <button type="button" className="btn ghost sm" onClick={() => setHelp('contact')}>Contacter l'administrateur</button>
          </div>
          {help && (
            <Alert tone="info">
              {help === 'oublie'
                ? "La réinitialisation d'un mot de passe se fait par l'administrateur de votre compagnie : demandez-lui de vous en définir un nouveau."
                : "Les comptes sont créés par l'administrateur de votre compagnie. Contactez-le pour obtenir un accès."}
            </Alert>
          )}
        </form>
      </div>
    </div>
  );
}
