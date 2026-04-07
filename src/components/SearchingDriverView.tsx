import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from './PressableScale';

type Props = {
  map: ReactNode;
  onCancel: () => void;
  cancelling: boolean;
};

export function SearchingDriverView({ map, onCancel, cancelling }: Props) {
  return (
    <View style={styles.root}>
      {map}
      <View style={styles.bottomSheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Recherche d’un chauffeur…</Text>
        <Text style={styles.subtitle}>
          Nous recherchons un chauffeur proche de vous
        </Text>
        <View style={styles.loaderRow}>
          <ActivityIndicator size="large" color="#0f766e" />
        </View>
        <PressableScale
          style={[styles.cancelBtn, cancelling && styles.cancelBtnDisabled]}
          pressedStyle={styles.cancelBtnPressed}
          disabledStyle={styles.cancelBtnDisabled}
          disabled={cancelling}
          onPress={onCancel}
        >
          <Text style={styles.cancelText}>
            {cancelling ? 'Annulation…' : 'Annuler la course'}
          </Text>
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  bottomSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 78,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#e5e7eb',
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '900',
    color: '#0f172a',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 14,
    lineHeight: 18,
  },
  loaderRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  cancelBtn: {
    marginTop: 10,
    height: 52,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#0f766e',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnPressed: {
    opacity: 0.92,
    backgroundColor: '#f0fdfa',
  },
  cancelBtnDisabled: {
    opacity: 0.7,
  },
  cancelText: {
    color: '#0f766e',
    fontWeight: '900',
    fontSize: 16,
  },
});

