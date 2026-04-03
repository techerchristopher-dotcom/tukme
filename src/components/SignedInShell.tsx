import type { Session } from '@supabase/supabase-js';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { APP_NAME } from '../constants/app';
import { supabase } from '../lib/supabase';
import type { Profile } from '../types/profile';
import { isCompleteRole } from '../types/profile';

type Props = {
  session: Session;
  profile: Profile;
  headline: string;
  onDevResetRole: () => Promise<void>;
  /** Contenu affiché entre la carte profil et les actions (ex. carte client). */
  middleContent?: ReactNode;
};

export function SignedInShell({
  session,
  profile,
  headline,
  onDevResetRole,
  middleContent,
}: Props) {
  const [signingOut, setSigningOut] = useState(false);
  const [resettingRole, setResettingRole] = useState(false);
  const email = session.user.email ?? '—';

  const roleLabel = isCompleteRole(profile.role)
    ? profile.role === 'client'
      ? 'Client'
      : 'Chauffeur'
    : 'Non défini';

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    setSigningOut(false);
  }

  async function handleDevResetRole() {
    setResettingRole(true);
    try {
      await onDevResetRole();
    } finally {
      setResettingRole(false);
    }
  }

  const core = (
    <>
      <Text style={styles.brand}>{APP_NAME}</Text>
      <Text style={styles.headline}>{headline}</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Rôle actuel</Text>
        <Text style={styles.value}>{roleLabel}</Text>

        <Text style={[styles.label, styles.labelSpaced]}>Nom affiché</Text>
        <Text style={styles.value}>
          {profile.full_name?.trim() ? profile.full_name : '—'}
        </Text>

        <Text style={[styles.label, styles.labelSpaced]}>Téléphone</Text>
        <Text style={styles.value}>
          {profile.phone?.trim() ? profile.phone : '—'}
        </Text>

        <Text style={[styles.label, styles.labelSpaced]}>Email</Text>
        <Text style={styles.value}>{email}</Text>
      </View>

      {middleContent}

      <Pressable
        style={[styles.secondaryButton, signingOut && styles.buttonDisabled]}
        onPress={() => void handleSignOut()}
        disabled={signingOut}
      >
        {signingOut ? (
          <ActivityIndicator color="#0f766e" />
        ) : (
          <Text style={styles.secondaryButtonText}>Se déconnecter</Text>
        )}
      </Pressable>

      <Pressable
        style={[styles.devButton, resettingRole && styles.buttonDisabled]}
        onPress={() => void handleDevResetRole()}
        disabled={resettingRole}
      >
        {resettingRole ? (
          <ActivityIndicator color="#64748b" />
        ) : (
          <Text style={styles.devButtonText}>
            Réinitialiser le rôle (dev)
          </Text>
        )}
      </Pressable>

      <StatusBar style="dark" />
    </>
  );

  if (middleContent) {
    return (
      <KeyboardAvoidingView
        style={styles.keyboardRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        enabled={Platform.OS === 'ios'}
      >
        <ScrollView
          style={styles.scrollRoot}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          bounces
        >
          {core}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return <View style={styles.container}>{core}</View>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  keyboardRoot: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollRoot: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 48,
    /* Espace défilable sous le bloc destination pour rester au-dessus du clavier (iPhone). */
    paddingBottom: 120,
  },
  brand: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 8,
  },
  headline: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  labelSpaced: {
    marginTop: 14,
  },
  value: {
    fontSize: 16,
    color: '#0f172a',
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 2,
    borderColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
    minWidth: 200,
    alignItems: 'center',
    marginBottom: 12,
  },
  devButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  secondaryButtonText: {
    color: '#0f766e',
    fontSize: 16,
    fontWeight: '600',
  },
  devButtonText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
});
