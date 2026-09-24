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
};

const LABELS: Record<string, string> = {
  in_progress: 'In progress',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONES[status] ?? 'neutral'}>
      {LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}
