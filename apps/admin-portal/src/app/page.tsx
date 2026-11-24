import { AdminLedgerWorkspace } from '@/components/AdminLedgerWorkspace';
import { fetchAdminOverviewStatus } from '@/lib/admin-overview';

export const dynamic = 'force-dynamic';

export default async function AdminHomePage() {
  const overviewStatus = await fetchAdminOverviewStatus();

  return <AdminLedgerWorkspace overviewStatus={overviewStatus} />;
}
