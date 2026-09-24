import type { Metadata } from 'next';
import { Lock } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Not available' };

export default function ModuleUnavailablePage() {
  return (
    <Card className="mx-auto mt-8 max-w-md">
      <CardBody className="px-6 py-10 text-center">
        <Lock className="text-muted-foreground mx-auto mb-3 size-6" aria-hidden="true" />
        <h1 className="text-foreground text-base font-semibold">This section is not available</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Your RamosMAX account does not have access to it. Ask an administrator if you need it.
        </p>
        <div className="mt-6">
          <LinkButton href="/" variant="secondary">
            Back to the dashboard
          </LinkButton>
        </div>
      </CardBody>
    </Card>
  );
}
