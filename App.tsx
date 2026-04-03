import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuthSession } from './src/hooks/useAuthSession';
import { useProfile } from './src/hooks/useProfile';
import { supabase } from './src/lib/supabase';
import { ClientHomeScreen } from './src/screens/ClientHomeScreen';
import { DriverHomeScreen } from './src/screens/DriverHomeScreen';
import { RoleSelectScreen } from './src/screens/RoleSelectScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { isCompleteRole } from './src/types/profile';

type AuthView = 'signIn' | 'signUp';

export default function App() {
  const { session, ready } = useAuthSession();
  const [authView, setAuthView] = useState<AuthView>('signIn');
  const userId = session?.user.id;
  const { profile, loading: profileLoading, error: profileError, refresh } =
    useProfile(userId);

  const devResetRole = useCallback(async () => {
    if (!userId) {
      return;
    }
    await supabase.from('profiles').update({ role: null }).eq('id', userId);
    await refresh();
  }, [userId, refresh]);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#0f766e" />
      </View>
    );
  }

  if (!session) {
    return authView === 'signIn' ? (
      <SignInScreen onGoToSignUp={() => setAuthView('signUp')} />
    ) : (
      <SignUpScreen onGoToSignIn={() => setAuthView('signIn')} />
    );
  }

  if (profileLoading) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#0f766e" />
      </View>
    );
  }

  if (profileError) {
    return (
      <View style={styles.boot}>
        <Text style={styles.errorTitle}>Profil indisponible</Text>
        <Text style={styles.errorText}>{profileError}</Text>
        <Pressable style={styles.retry} onPress={() => void refresh()}>
          <Text style={styles.retryText}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.boot}>
        <Text style={styles.errorTitle}>Profil introuvable</Text>
        <Text style={styles.errorText}>
          La ligne « profiles » n’existe pas pour ce compte. Déconnectez-vous
          puis créez un nouveau compte, ou vérifiez le trigger côté Supabase.
        </Text>
        <Pressable
          style={styles.retry}
          onPress={() => void supabase.auth.signOut()}
        >
          <Text style={styles.retryText}>Se déconnecter</Text>
        </Pressable>
      </View>
    );
  }

  if (!isCompleteRole(profile.role)) {
    return (
      <RoleSelectScreen
        session={session}
        userId={session.user.id}
        onUpdated={refresh}
      />
    );
  }

  if (profile.role === 'client') {
    return (
      <ClientHomeScreen
        session={session}
        profile={profile}
        onDevResetRole={devResetRole}
      />
    );
  }

  return (
    <DriverHomeScreen
      session={session}
      profile={profile}
      onDevResetRole={devResetRole}
    />
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 20,
  },
  retry: {
    backgroundColor: '#0f766e',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
});
