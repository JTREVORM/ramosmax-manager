import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="bg-brand-purple text-brand-gold mb-4 flex size-16 items-center justify-center rounded-2xl text-xl font-bold">
          RM
        </div>
        <h1 className="text-foreground text-xl font-semibold">RamosMAX</h1>
        <p className="text-muted-foreground mt-1 text-sm">Management System</p>
      </div>
      <LoginForm />
    </div>
  );
}
