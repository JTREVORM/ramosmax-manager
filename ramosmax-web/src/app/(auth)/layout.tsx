export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <main className="flex flex-1 items-center justify-center px-4 py-8">{children}</main>
      <footer className="text-muted-foreground px-4 pb-6 text-center text-xs">
        RamosMAX Automotive Care (U) Ltd
      </footer>
    </div>
  );
}
