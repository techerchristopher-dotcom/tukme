import { useCallback, useMemo, useRef } from 'react';
import {
  Animated,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  disabledStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  opacityTo?: number;
};

export function PressableScale(props: Props) {
  const {
    children,
    style,
    pressedStyle,
    disabledStyle,
    disabled,
    scaleTo = 0.97,
    opacityTo = 0.8,
    onPressIn,
    onPressOut,
    ...rest
  } = props;

  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const animateTo = useCallback(
    (to: number, toOpacity: number) => {
      Animated.parallel([
        Animated.spring(scale, {
          toValue: to,
          speed: 26,
          bounciness: 0,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: toOpacity,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [opacity, scale]
  );

  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (e) => {
      if (!disabled) {
        animateTo(scaleTo, opacityTo);
      }
      onPressIn?.(e);
    },
    [animateTo, disabled, onPressIn, opacityTo, scaleTo]
  );

  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (e) => {
      animateTo(1, 1);
      onPressOut?.(e);
    },
    [animateTo, onPressOut]
  );

  const containerStyle = useMemo(() => {
    return [{ transform: [{ scale }], opacity }] as StyleProp<ViewStyle>;
  }, [opacity, scale]);

  return (
    <Animated.View style={containerStyle}>
      <Pressable
        {...rest}
        disabled={disabled}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={({ pressed }) => [
          style,
          pressed ? pressedStyle : null,
          disabled ? disabledStyle : null,
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

