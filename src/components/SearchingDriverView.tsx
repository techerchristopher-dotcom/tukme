import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { PressableScale } from './PressableScale';
import { SearchRadar } from './SearchRadar';
import { DriverSearchStatus } from './DriverSearchStatus';
import { DRIVER_SEARCH_COPY_FR } from '../constants/driverSearchCopy.fr';

type Props = {
  map: ReactNode;
  onCancel: () => void;
  onEditRide: () => void;
  cancelling: boolean;
  /** Affichage lecture seule après commande (snapshot `rides.passenger_count`). */
  passengerCount: number;
  /** Labels EXACTS choisis par l’utilisateur (structuredPickup/structuredDestination). */
  pickupLabel: string | null;
  destinationLabel: string | null;
};

export function SearchingDriverView({
  map,
  onCancel,
  onEditRide,
  cancelling,
  passengerCount,
  pickupLabel,
  destinationLabel,
}: Props) {
  const showTripSummary =
    !!pickupLabel?.trim() && !!destinationLabel?.trim();

  return (
    <View style={styles.root}>
      {map}
      <View pointerEvents="none" style={styles.radarOverlay}>
        <SearchRadar size={108} color="#0f766e" maxOpacity={0.22} />
      </View>
      <View style={styles.bottomSheet}>
        <View style={styles.grabber} />
        <Text style={styles.passengersLine}>Passagers : {passengerCount}</Text>
        <DriverSearchStatus
          title={DRIVER_SEARCH_COPY_FR.title}
          messages={[...DRIVER_SEARCH_COPY_FR.microcopy]}
          accentColor="#0f766e"
        />
        {showTripSummary ? (
          <View style={styles.tripSummary}>
            <View style={styles.tripRow}>
              <View style={styles.tripIconWrap}>
                <Ionicons name="location" size={18} color="#16a34a" />
              </View>
              <Text
                style={styles.tripText}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {pickupLabel}
              </Text>
            </View>
            <View style={styles.tripDivider} />
            <View style={styles.tripRow}>
              <View style={styles.tripIconWrap}>
                <Ionicons name="flag" size={18} color="#ef4444" />
              </View>
              <Text
                style={styles.tripText}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {destinationLabel}
              </Text>
            </View>
          </View>
        ) : null}
        <View style={styles.loaderRow}>
          <ActivityIndicator size="large" color="#0f766e" />
        </View>

        <View style={styles.actionsRow}>
          <PressableScale
            style={styles.editBtn}
            pressedStyle={styles.editBtnPressed}
            onPress={onEditRide}
          >
            <View style={styles.editBtnInner}>
              <Ionicons name="create-outline" size={18} color="#0f172a" />
              <Text style={styles.editBtnText}>
                {DRIVER_SEARCH_COPY_FR.editRide}
              </Text>
            </View>
          </PressableScale>

          <PressableScale
            style={[styles.cancelBtn, cancelling && styles.cancelBtnDisabled]}
            pressedStyle={styles.cancelBtnPressed}
            disabledStyle={styles.cancelBtnDisabled}
            disabled={cancelling}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>
              {cancelling
                ? DRIVER_SEARCH_COPY_FR.cancelling
                : DRIVER_SEARCH_COPY_FR.cancelRide}
            </Text>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  radarOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 78,
    alignItems: 'center',
    justifyContent: 'center',
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
  passengersLine: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  tripSummary: {
    marginTop: 6,
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  tripIconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tripText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#1f2937',
  },
  tripDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginLeft: 24 + 10, // icon width + gap
  },
  loaderRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
  },
  editBtn: {
    flex: 1,
    height: 52,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtnPressed: {
    opacity: 0.92,
    backgroundColor: '#f8fafc',
  },
  editBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  editBtnText: {
    color: '#0f172a',
    fontWeight: '900',
    fontSize: 15,
  },
  cancelBtn: {
    flex: 1,
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

