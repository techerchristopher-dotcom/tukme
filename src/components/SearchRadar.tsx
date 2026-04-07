import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

type Props = {
  /** Diamètre de base du pulse (en px). */
  size?: number;
  /** Couleur du pulse (ex. brand). */
  color?: string;
  /** Opacité max de départ (ex. 0.25). */
  maxOpacity?: number;
  /** Durée d’un pulse (ms). */
  durationMs?: number;
  /** Nombre de cercles (2–3). */
  rings?: number;
  /** Décalage entre rings (ms). */
  staggerMs?: number;
};

function makeRingAnim(
  scale: Animated.Value,
  opacity: Animated.Value,
  durationMs: number,
  delayMs: number,
  maxOpacity: number
) {
  return Animated.loop(
    Animated.sequence([
      Animated.delay(delayMs),
      Animated.parallel([
        Animated.timing(scale, {
          toValue: 1,
          duration: 0,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: maxOpacity,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(scale, {
          toValue: 2.5,
          duration: durationMs,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: durationMs,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    ])
  );
}

/**
 * Overlay premium “radar-like pulses”.
 * Positionnement: le parent doit l’absolutiser et le centrer sur le pickup.
 */
export const SearchRadar = memo(function SearchRadar({
  size = 96,
  color = '#0f766e',
  maxOpacity = 0.22,
  durationMs = 2400,
  rings = 3,
  staggerMs = 650,
}: Props) {
  const ringCount = Math.max(2, Math.min(3, rings));

  const scales = useRef(
    Array.from({ length: ringCount }, () => new Animated.Value(1))
  ).current;
  const opacities = useRef(
    Array.from({ length: ringCount }, () => new Animated.Value(0))
  ).current;

  useEffect(() => {
    const animations = scales.map((s, idx) =>
      makeRingAnim(s, opacities[idx], durationMs, idx * staggerMs, maxOpacity)
    );
    animations.forEach((a) => a.start());
    return () => {
      animations.forEach((a) => a.stop());
    };
  }, [durationMs, maxOpacity, opacities, scales, staggerMs]);

  const ringStyleBase = useMemo(
    () => [
      styles.ring,
      {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      },
    ],
    [color, size]
  );

  return (
    <View pointerEvents="none" style={styles.root}>
      {Array.from({ length: ringCount }).map((_, idx) => (
        <Animated.View
          // eslint-disable-next-line react/no-array-index-key -- stable ring list
          key={idx}
          style={[
            ringStyleBase,
            {
              opacity: opacities[idx],
              transform: [{ scale: scales[idx] }],
            },
          ]}
        />
      ))}
      <View
        style={[
          styles.core,
          {
            width: 10,
            height: 10,
            borderRadius: 999,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    width: 1,
    height: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
  },
  core: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
});

