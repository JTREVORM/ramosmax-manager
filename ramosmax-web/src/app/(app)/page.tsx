import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-foreground text-lg font-semibold">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Phase A — foundation. Business screens arrive in Phases B to I.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Foundation in place</CardTitle>
        </CardHeader>
        <CardBody className="text-muted-foreground space-y-2 text-sm">
          <p>
            The permission catalogue, access helpers and default-deny posture are generated from the
            Phase 9 reference implementation and applied as database migrations.
          </p>
          <p>
            Navigation, the responsive shell and the table/card data view are built and driven by
            effective permissions, not by role.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
