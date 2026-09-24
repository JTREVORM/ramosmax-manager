import 'server-only';
import { redirect } from 'next/navigation';
import { currentPermissions } from './auth-service';

/**
 * Sends someone without the permission to the "not available" screen, which is
 * the web equivalent of the reference implementation's ModuleNotAvailableScreen.
 *
 * This is navigation, not security. Every query behind it runs under RLS and
 * every mutation re-checks the caller, so removing this guard would change
 * what a person SEES and nothing about what they can reach.
 */
export async function requireAnyPermission(...anyOf: string[]): Promise<Set<string>> {
  const granted = await currentPermissions();
  if (!anyOf.some((permission) => granted.has(permission))) {
    redirect('/module-unavailable');
  }
  return granted;
}
