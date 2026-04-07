import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

type Props = {
  title?: string;
  /** Microcopy “alive” (rotates every few seconds). */
  messages?: string[];
  /** Brand accent (progress + small highlights). */
  accentColor?: string;
};

const DEFAULT_MESSAGES = [
  'Nous contactons les chauffeurs à proximité',
  'Nous cherchons le meilleur chauffeur pour vous',
  'Vérification des disponibilités autour de vous',
];

export const DriverSearchStatus = memo(function DriverSearchStatus({
  title = 'Recherche d’un chauffeur…',
  messages = DEFAULT_MESSAGES,
  accentColor = '#0f766e',
}: Props) {
  const safeMessages = useMemo(() => {
    const m = (messages ?? []).map((s) => s.trim()).filter(Boolean);
    return m.length > 0 ? m : DEFAULT_MESSAGES;
  }, [messages]);

  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setInterval(() => {
      Animated.sequence([
        Animated.parallel([
          Animated.timing(fade, {
            toValue: 0,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(lift, {
            toValue: 6,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(lift, {
          toValue: -6,
          duration: 1,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (!finished) return;
        setIdx((i) => (i + 1) % safeMessages.length);
        Animated.parallel([
          Animated.timing(fade, {
            toValue: 1,
            duration: 220,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(lift, {
            toValue: 0,
            duration: 220,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start();
      });
    }, 3200);

    return () => clearInterval(id);
  }, [fade, lift, safeMessages.length]);

  const shimmerX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(shimmerX, {
        toValue: 1,
        duration: 1700,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [shimmerX]);

  const translateX = shimmerX.interpolate({
    inputRange: [0, 1],
    outputRange: [-220, 220],
  });

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{title}</Text>
      <Animated.Text
        style={[
          styles.subtitle,
          { opacity: fade, transform: [{ translateY: lift }] },
        ]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {safeMessages[idx]}
      </Animated.Text>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFillBase, { backgroundColor: accentColor }]} />
        <Animated.View
          style={[
            styles.shimmer,
            { transform: [{ translateX }] },
          ]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={[
              'rgba(255,255,255,0)',
              'rgba(255,255,255,0.55)',
              'rgba(255,255,255,0)',
            ]}
            locations={[0, 0.5, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.shimmerGradient}
          />
        </Animated.View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    width: '100%',
    marginTop: 2,
    marginBottom: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '900',
    color: '#0f172a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 10,
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
    overflow: 'hidden',
  },
  progressFillBase: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '35%',
    opacity: 0.28,
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 140,
  },
  shimmerGradient: {
    flex: 1,
  },
});

