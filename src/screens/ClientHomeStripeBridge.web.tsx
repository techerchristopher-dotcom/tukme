import type { ReactNode } from 'react';

type RootProps = {
  publishableKey: string;
  children: ReactNode;
};

/** Pas de module natif Stripe sur web — évite d’importer @stripe/stripe-react-native. */
export function ClientStripeRoot({ children }: RootProps) {
  return <>{children}</>;
}

export function useClientStripeSheet() {
  return {
    initPaymentSheet: async () => ({
      error: {
        code: 'Failed',
        message:
          'Le paiement in-app n’est pas disponible sur le web. Utilisez l’application mobile.',
      },
    }),
    presentPaymentSheet: async () => ({ error: undefined }),
  };
}
