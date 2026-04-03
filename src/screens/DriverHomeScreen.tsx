import type { Session } from '@supabase/supabase-js';

import { SignedInShell } from '../components/SignedInShell';
import type { Profile } from '../types/profile';

type Props = {
  session: Session;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
};

export function DriverHomeScreen({
  session,
  profile,
  onDevResetRole,
}: Props) {
  return (
    <SignedInShell
      session={session}
      profile={profile}
      headline="Espace chauffeur"
      onDevResetRole={onDevResetRole}
    />
  );
}
