import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { RequireAuth, RequirePermission } from './components/Guard';
import { Loading } from './components/ui';
import { mainSpaceFor } from './lib/nav';
import { useUser } from './lib/session';
import { LoginPage } from './pages/Login';
import { NoSpace, NotFound } from './pages/Misc';

// Chaque espace est un morceau chargé à la demande : le caissier ne télécharge pas l'administration.
const Billetterie = lazy(() => import('./pages/Billetterie'));
const Controle = lazy(() => import('./pages/Controle'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Administration = lazy(() => import('./pages/Administration'));
const Compagnies = lazy(() => import('./pages/Compagnies'));
const LignesList = lazy(() => import('./pages/Lignes').then((m) => ({ default: m.LignesList })));
const LigneDetail = lazy(() => import('./pages/Lignes').then((m) => ({ default: m.LigneDetail })));
const ClientsList = lazy(() => import('./pages/Clients').then((m) => ({ default: m.ClientsList })));
const ClientDetail = lazy(() => import('./pages/Clients').then((m) => ({ default: m.ClientDetail })));

function Home() {
  const user = useUser();
  return <Navigate to={mainSpaceFor(user)} replace />;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/connexion" element={<LoginPage />} />
        <Route element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="/accueil" element={<NoSpace />} />
          <Route path="/tableau-de-bord" element={<RequirePermission permission="reporting:lire"><Dashboard /></RequirePermission>} />
          <Route path="/billetterie" element={<RequirePermission permission="billetterie:lire"><Billetterie /></RequirePermission>} />
          <Route path="/controle" element={<RequirePermission permission="controle:lire"><Controle /></RequirePermission>} />
          <Route path="/lignes" element={<RequirePermission permission="lignes:lire"><LignesList /></RequirePermission>} />
          <Route path="/lignes/:id" element={<RequirePermission permission="lignes:lire"><LigneDetail /></RequirePermission>} />
          <Route path="/clients" element={<RequirePermission permission="clients:lire"><ClientsList /></RequirePermission>} />
          <Route path="/clients/:id" element={<RequirePermission permission="clients:lire"><ClientDetail /></RequirePermission>} />
          <Route path="/administration" element={<RequirePermission permission="administration:administrer"><Administration /></RequirePermission>} />
          <Route path="/compagnies" element={<RequirePermission permission="plateforme:administrer"><Compagnies /></RequirePermission>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
