import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './status-badge';

/**
 * Statuses arrive from the database in snake_case. A status with no entry here
 * is title-cased, which is fine for `paid` and wrong for `partially_paid` —
 * "Partially_paid" is not a thing a cashier should ever read.
 */
describe('status badge', () => {
  it('writes every payment status the way the reference implementation does', () => {
    const cases: [string, string][] = [
      ['unpaid', 'Unpaid'],
      ['partially_paid', 'Partially paid'],
      ['credit', 'Credit'],
      ['paid', 'Paid'],
      ['cancelled', 'Cancelled'],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('never shows an underscore', () => {
    for (const status of ['partially_paid', 'in_progress']) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).not.toContain('_');
      unmount();
    }
  });
});
