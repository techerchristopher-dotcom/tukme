import { StripeProvider, useStripe } from '@stripe/stripe-react-native';
import type { ReactElement, ReactNode } from 'react';

type RootProps = {
  publishableKey: string;
  children: ReactNode;
};

export function ClientStripeRoot({ publishableKey, children }: RootProps) {
  return (
    <StripeProvider publishableKey={publishableKey}>
      {children as ReactElement | ReactElement[]}
    </StripeProvider>
  );
}

export function useClientStripeSheet() {
  return useStripe();
}
