import type { CampaignStatus } from "@vetrix/domain";
import { Badge } from "@/components/ui/badge";

const LABEL: Record<CampaignStatus, { text: string; variant: "muted" | "secondary" | "success" | "warning" | "danger" }> = {
  draft: { text: "Draft", variant: "muted" },
  approved: { text: "Approved", variant: "secondary" },
  scheduled: { text: "Scheduled", variant: "secondary" },
  sending: { text: "Sending", variant: "warning" },
  sent: { text: "Sent", variant: "success" },
  cancelled: { text: "Cancelled", variant: "danger" },
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const s = LABEL[status];
  return <Badge variant={s.variant}>{s.text}</Badge>;
}
