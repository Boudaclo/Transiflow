import { useState } from 'react';
import { PageHead, Tabs } from '../components/ui';
import { can } from '../lib/nav';
import { usePoste } from '../lib/poste';
import { useUser } from '../lib/session';
import { TicketList } from './billetterie/History';
import { PostePanel } from './billetterie/PostePanel';
import { SaleScreen } from './billetterie/SaleScreen';

export default function BilletteriePage() {
  const user = useUser();
  const canSell = can(user, 'billetterie:vendre');
  const { poste, state } = usePoste('vente', canSell);
  const [tab, setTab] = useState<'vente' | 'historique'>(canSell ? 'vente' : 'historique');
  return (
    <>
      <PageHead title="Billetterie" subtitle={canSell ? 'Vente rapide et historique des tickets' : 'Historique des tickets'} />
      {canSell && <PostePanel poste={poste} state={state} kind="vente" />}
      {canSell && <Tabs label="Billetterie" value={tab} onChange={setTab} tabs={[{ id: 'vente', label: 'Vente rapide' }, { id: 'historique', label: 'Historique' }]} />}
      {tab === 'vente' && canSell ? <SaleScreen poste={poste} state={state} /> : <div className="card"><TicketList canCancel={can(user, 'billetterie:annuler')} canVerify={can(user, 'administration:administrer')} /></div>}
    </>
  );
}
