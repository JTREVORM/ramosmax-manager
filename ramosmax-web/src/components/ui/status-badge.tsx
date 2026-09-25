import { Badge, type BadgeTone } from './badge';

/** One place decides how a status looks, so the colour never contradicts itself. */
const TONES: Record<string, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  open: 'info',
  draft: 'neutral',
  completed: 'success',
  cancelled: 'danger',
  pending: 'neutral',
  assigned: 'info',
  accepted: 'info',
  in_progress: 'warning',
  paused: 'warning',

  // Payment status, with the tones the reference implementation uses in
  // `PaymentStatusChip` (billing_widgets.dart): an unpaid invoice is a problem,
  // a part payment and credit are things to watch, paid is settled.
  unpaid: 'danger',
  partially_paid: 'warning',
  credit: 'warning',
  paid: 'success',
  reversed: 'danger',

  // Loyalty rewards.
  available: 'success',
  redeemed: 'info',
  revoked: 'neutral',
};

const LABELS: Record<string, string> = {
  in_progress: 'In progress',
  partially_paid: 'Partially paid',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONES[status] ?? 'neutral'}>
      {LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}
