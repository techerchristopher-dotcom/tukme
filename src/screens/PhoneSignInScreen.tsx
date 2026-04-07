import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Props = {
  onGoToSignUp: () => void;
  onGoToEmailSignIn: () => void;
};

function normalizeDigits(input: string) {
  return input.replace(/[^\d]/g, '');
}

function buildE164Phone(countryCallingCode: string, nationalNumber: string) {
  const digits = normalizeDigits(nationalNumber).replace(/^0+/, '');
  if (!digits) {
    return '';
  }
  return `${countryCallingCode}${digits}`;
}

export function PhoneSignInScreen({ onGoToSignUp, onGoToEmailSignIn }: Props) {
  const [countryCallingCode] = useState('+262');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const phoneInputRef = useRef<TextInput>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      phoneInputRef.current?.focus();
    }, 250);
    return () => clearTimeout(t);
  }, []);

  const e164Phone = useMemo(
    () => buildE164Phone(countryCallingCode, phone),
    [countryCallingCode, phone]
  );

  const canContinue = !loading && e164Phone.length > countryCallingCode.length;

  async function handleContinue() {
    if (!canContinue) {
      return;
    }
    // MVP UI-only: wire Supabase phone auth later (signInWithOtp + verifyOtp).
    setLoading(true);
    setTimeout(() => setLoading(false), 450);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.center}>
        <Text style={styles.title}>Saisissez votre numéro de téléphone</Text>

        <View style={styles.phoneRow}>
          <Pressable style={styles.countryBlock} onPress={() => {}}>
            <Text style={styles.flag}>🇷🇪</Text>
            <Text style={styles.countryCode}>{countryCallingCode}</Text>
            <Text style={styles.dropdown}>▾</Text>
          </Pressable>

          <View style={styles.phoneInputBlock}>
            <TextInput
              ref={phoneInputRef}
              style={styles.phoneInput}
              placeholder="639409805"
              placeholderTextColor="#94a3b8"
              keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
              value={phone}
              onChangeText={setPhone}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
              maxLength={18}
              textContentType="telephoneNumber"
            />
          </View>
        </View>

        <Pressable
          style={[
            styles.primaryButton,
            (!canContinue || loading) && styles.primaryButtonDisabled,
          ]}
          onPress={() => void handleContinue()}
          disabled={!canContinue}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>Se connecter</Text>
          )}
        </Pressable>

        <View style={styles.separatorRow}>
          <View style={styles.separatorLine} />
          <Text style={styles.separatorText}>OU</Text>
          <View style={styles.separatorLine} />
        </View>

        <View style={styles.socialStack}>
          <Pressable style={styles.socialButton} onPress={() => {}}>
            <View style={styles.socialIcon}>
              <Text style={styles.socialIconText}></Text>
            </View>
            <Text style={styles.socialButtonText}>Continuer avec Apple</Text>
          </Pressable>

          <Pressable style={styles.socialButton} onPress={() => {}}>
            <View style={styles.socialIcon}>
              <Text style={styles.socialIconText}>G</Text>
            </View>
            <Text style={styles.socialButtonText}>Continuer avec Google</Text>
          </Pressable>

          <Pressable style={styles.socialButton} onPress={() => {}}>
            <View style={styles.socialIcon}>
              <Text style={styles.socialIconText}>f</Text>
            </View>
            <Text style={styles.socialButtonText}>Continuer avec Facebook</Text>
          </Pressable>
        </View>

        <Pressable style={styles.emailLinkWrap} onPress={onGoToEmailSignIn}>
          <Text style={styles.emailLink}>Continuer avec l’email</Text>
        </Pressable>

        <Pressable style={styles.linkWrap} onPress={onGoToSignUp}>
          <Text style={styles.link}>Pas de compte ? S’inscrire</Text>
        </Pressable>
      </View>

      <Text style={styles.legal}>
        En vous inscrivant, vous acceptez nos{' '}
        <Text
          style={styles.legalLink}
          onPress={() => void Linking.openURL('https://example.com/terms')}
        >
          conditions générales
        </Text>
        , reconnaissez notre{' '}
        <Text
          style={styles.legalLink}
          onPress={() => void Linking.openURL('https://example.com/privacy')}
        >
          politique de confidentialité
        </Text>{' '}
        et confirmez avoir plus de 18 ans.
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    width: '100%',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 340,
  },
  phoneRow: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: 420,
    gap: 12,
    marginBottom: 18,
  },
  countryBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 56,
    gap: 8,
  },
  flag: {
    fontSize: 16,
  },
  countryCode: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  dropdown: {
    fontSize: 14,
    color: '#64748b',
    marginLeft: 2,
  },
  phoneInputBlock: {
    flex: 1,
    height: 56,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  phoneInput: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
  },
  primaryButton: {
    width: '100%',
    maxWidth: 420,
    height: 56,
    borderRadius: 999,
    backgroundColor: '#15803d',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  separatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: 420,
    gap: 12,
    marginBottom: 18,
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#d1d5db',
  },
  separatorText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    letterSpacing: 1,
  },
  socialStack: {
    width: '100%',
    maxWidth: 420,
    gap: 12,
    marginBottom: 18,
  },
  socialButton: {
    height: 56,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  socialIcon: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  socialIconText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  socialButtonText: {
    flex: 1,
    textAlign: 'center',
    marginRight: 26,
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  linkWrap: {
    marginTop: 6,
    alignItems: 'center',
  },
  emailLinkWrap: {
    marginTop: 4,
    marginBottom: 6,
    alignItems: 'center',
  },
  link: {
    color: '#15803d',
    fontSize: 15,
    fontWeight: '600',
  },
  emailLink: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  legal: {
    marginTop: 18,
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 16,
  },
  legalLink: {
    color: '#15803d',
    fontWeight: '700',
  },
});

