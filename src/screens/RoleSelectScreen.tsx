import type { Session } from '@supabase/supabase-js';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { APP_NAME } from '../constants/app';
import { supabase } from '../lib/supabase';
import type { UserRole } from '../types/profile';

type Props = {
  session: Session;
  userId: string;
  onUpdated: () => Promise<void>;
};

export function RoleSelectScreen({ session, userId, onUpdated }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = session.user.email ?? '—';

  async function chooseRole(role: UserRole) {
    setError(null);
    setLoading(true);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', userId);
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await onUpdated();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>{APP_NAME}</Text>
      <Text style={styles.title}>Comment utilisez-vous l’app ?</Text>
      <Text style={styles.hint}>{email}</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.choice, loading && styles.choiceDisabled]}
        onPress={() => void chooseRole('client')}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.choiceText}>Je suis client</Text>
        )}
      </Pressable>

      <Pressable
        style={[styles.choiceOutline, loading && styles.choiceDisabled]}
        onPress={() => void chooseRole('driver')}
        disabled={loading}
      >
        <Text style={[styles.choiceText, styles.choiceTextOutline]}>
          Je suis chauffeur
        </Text>
      </Pressable>

      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  brand: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
    marginBottom: 8,
  },
  hint: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 28,
  },
  error: {
    color: '#b91c1c',
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  choice: {
    backgroundColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  choiceOutline: {
    borderWidth: 2,
    borderColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  choiceDisabled: {
    opacity: 0.7,
  },
  choiceText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  choiceTextOutline: {
    color: '#0f766e',
  },
});
