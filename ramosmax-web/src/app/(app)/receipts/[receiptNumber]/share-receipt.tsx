'use client';

import * as React from 'react';
import { Printer, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Sharing a receipt.
 *
 * Uses the Web Share API where the browser has it — which on a phone reaches
 * WhatsApp, SMS and email, the same destinations the reference implementation
 * reaches through the system share sheet. Elsewhere it copies the text.
 */
export function ShareReceipt({ snapshot }: { snapshot: Record<string, unknown> }) {
  const [copied, setCopied] = React.useState(false);

  const text = React.useMemo(() => {
    const s = snapshot as {
      businessName: string; receiptNumber: string; numberPlate: string;
      totalUgx: number; paymentUgx: number; balanceUgx: number;
    };
    const ugx = (n: number) => `UGX ${n.toLocaleString('en-UG')}`;
    return [
      s.businessName,
      `Receipt ${s.receiptNumber}`,
      `Vehicle ${s.numberPlate}`,
      `Total ${ugx(s.totalUgx)}`,
      `Paid ${ugx(s.paymentUgx)}`,
      `Balance ${ugx(s.balanceUgx)}`,
    ].join('\n');
  }, [snapshot]);

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The person cancelled the share sheet, or the clipboard is blocked.
    }
  }

  return (
    <div className="flex gap-2 print:hidden">
      <Button variant="secondary" block onClick={share}>
        <Share2 aria-hidden="true" />
        {copied ? 'Copied' : 'Share'}
      </Button>
      <Button variant="secondary" block onClick={() => window.print()}>
        <Printer aria-hidden="true" />
        Print
      </Button>
    </div>
  );
}
