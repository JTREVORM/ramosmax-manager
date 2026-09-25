/**
 * Small shared descriptions of workforce facts.
 *
 * They live here, and not beside a table, because both the server pages and
 * the client tables need them — and a value exported from a `'use client'`
 * module cannot be called on the server.
 */
import type { AllowanceRow, AttendanceRow, LossRow } from '@/lib/server/workforce';

/** "45 min late", or what happened instead. */
export function lateness(
  row: Pick<AttendanceRow, 'arrival_status' | 'late' | 'minutes_late'>,
): string {
  if (row.arrival_status === 'absent') return 'Absent';
  if (row.arrival_status === 'excused') return 'Excused';
  if (!row.late) return 'On time';
  const hours = Math.floor(row.minutes_late / 60);
  const minutes = row.minutes_late % 60;
  return `${hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`} late`;
}

/** What an allowance will actually pay: the decision, once someone made one. */
export const payable = (
  a: Pick<AllowanceRow, 'approved_amount_ugx' | 'calculated_amount_ugx' | 'deduction_ugx'>,
): number => a.approved_amount_ugx ?? a.calculated_amount_ugx - a.deduction_ugx;

export const LOSS_TYPE_LABELS: Record<string, string> = {
  damaged_equipment: 'Damaged equipment',
  damaged_customer_property: 'Damaged customer property',
  stock_loss: 'Stock loss',
  worker_related_loss: 'Worker-related loss',
  other: 'Other business loss',
};

export const lossType = (incident: Pick<LossRow, 'incident_type'>): string =>
  LOSS_TYPE_LABELS[incident.incident_type] ?? incident.incident_type;
