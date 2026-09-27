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

  // Stock levels.
  ok: 'success',
  low: 'warning',
  out_of_stock: 'danger',

  // Expenses and purchases.
  pending_review: 'warning',
  pending_approval: 'warning',
  approved: 'info',
  rejected: 'danger',
  received: 'success',
  balanced: 'success',
  discrepancy: 'warning',
  adjusted: 'info',

  // Loyalty rewards.
  available: 'success',
  redeemed: 'info',
  revoked: 'neutral',

  // Attendance (Phase F). Late is a fact to see, not a failure; a rejected
  // record is.
  pending_verification: 'warning',
  present: 'success',
  on_time: 'success',
  late: 'warning',
  severely_late: 'danger',
  absent: 'danger',
  excused: 'info',

  // Allowances and payroll.
  calculated: 'neutral',
  full: 'success',
  deduct: 'warning',
  prepared: 'info',
  locked: 'success',
  superseded: 'neutral',

  // Loss incidents and deductions.
  reported: 'warning',
  under_review: 'warning',
  recovery_scheduled: 'info',
  partially_recovered: 'warning',
  recovered: 'success',
};

const LABELS: Record<string, string> = {
  in_progress: 'In progress',
  partially_paid: 'Partially paid',
  out_of_stock: 'Out of stock',
  pending_review: 'Awaiting review',
  pending_approval: 'Awaiting approval',
  pending_verification: 'Awaiting verification',
  on_time: 'On time',
  severely_late: 'Severely late',
  under_review: 'Under review',
  recovery_scheduled: 'Recovery scheduled',
  partially_recovered: 'Partly recovered',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONES[status] ?? 'neutral'}>
      {LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}
