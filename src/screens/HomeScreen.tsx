import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import { APP_NAME } from '../constants/app';

export function HomeScreen() {
  const subtitle = 'Expo · React Native · TypeScript';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Bienvenue sur {APP_NAME}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    color: '#475569',
    textAlign: 'center',
  },
});
