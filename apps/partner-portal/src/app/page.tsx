import { PartnerWorkspace } from '@/components/PartnerWorkspace';
import { fetchPartnerOverviewStatus } from '@/lib/partner-overview';

export const dynamic = 'force-dynamic';

export default async function PartnerHomePage() {
  const overviewStatus = await fetchPartnerOverviewStatus();

  return <PartnerWorkspace overviewStatus={overviewStatus} />;
}
