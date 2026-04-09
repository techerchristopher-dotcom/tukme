import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuthSession } from './src/hooks/useAuthSession';
import { useProfile } from './src/hooks/useProfile';
import {
  registerForPushNotificationsAsync,
  registerForPushNotificationsIfPossible,
  wirePushListeners,
} from './src/lib/pushNotifications';
import { supabase } from './src/lib/supabase';
import { ClientHomeScreen } from './src/screens/ClientHomeScreen';
import { DriverHomeScreen } from './src/screens/DriverHomeScreen';
import { PhoneSignInScreen } from './src/screens/PhoneSignInScreen';
import { RoleSelectScreen } from './src/screens/RoleSelectScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { isCompleteRole } from './src/types/profile';
import { SignInScreen } from './src/screens/SignInScreen';

type AuthView = 'phone' | 'emailSignIn' | 'emailSignUp';

export default function App() {
  const { session, ready } = useAuthSession();
  const [authView, setAuthView] = useState<AuthView>('phone');
  const userId = session?.user.id;
  const { profile, loading: profileLoading, error: profileError, refresh } =
    useProfile(userId);

  useEffect(() => {
    void registerForPushNotificationsAsync();
  }, []);

  useEffect(() => {
    if (!session?.user?.id) {
      return;
    }
    void registerForPushNotificationsIfPossible(session.user.id);
  }, [session?.user?.id]);

  useEffect(() => {
    const sub = wirePushListeners({
      onTap: () => {
        // MVP: no navigation yet, keep listener for later.
      },
    });
    return () => sub.remove();
  }, []);

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
    if (authView === 'phone') {
      return (
        <PhoneSignInScreen
          onGoToSignUp={() => setAuthView('emailSignUp')}
          onGoToEmailSignIn={() => setAuthView('emailSignIn')}
        />
      );
    }
    if (authView === 'emailSignUp') {
      return (
        <SignUpScreen
          onGoToSignIn={() => setAuthView('emailSignIn')}
          onGoBack={() => setAuthView('phone')}
        />
      );
    }
    return (
      <SignInScreen
        onGoToSignUp={() => setAuthView('emailSignUp')}
        onGoBack={() => setAuthView('phone')}
      />
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
