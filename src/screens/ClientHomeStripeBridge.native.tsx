import { StripeProvider, useStripe } from '@stripe/stripe-react-native';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect } from 'react';
import { Linking } from 'react-native';

type RootProps = {
  publishableKey: string;
  /** Doit être identique à expo.scheme (app.json) — requis pour 3DS / retours depuis hooks.stripe.com. */
  urlScheme?: string;
  children: ReactNode;
};

/**
 * Stripe exige explicitement de transmettre les deep links au SDK après un redirect
 * (Safari / hooks.stripe.com). Sans cet appel, `returnURL` seul ne suffit pas.
 * @see https://stripe.com/docs/payments/accept-a-payment?platform=react-native&ui=payment-sheet
 */
function StripeDeepLinkBridge({ children }: { children: ReactNode }) {
  const { handleURLCallback } = useStripe();

  const forwardStripeUrl = useCallback(
    async (url: string | null) => {
      if (!url?.trim()) {
        return;
      }
      await handleURLCallback(url);
    },
    [handleURLCallback]
  );

  useEffect(() => {
    let alive = true;

    void (async () => {
      const initial = await Linking.getInitialURL();
      if (alive) {
        await forwardStripeUrl(initial);
      }
    })();

    const sub = Linking.addEventListener('url', (event) => {
      void forwardStripeUrl(event.url);
    });

    return () => {
      alive = false;
      sub.remove();
    };
  }, [forwardStripeUrl]);

  return <>{children}</>;
}

export function ClientStripeRoot({
  publishableKey,
  urlScheme = 'tukme',
  children,
}: RootProps) {
  return (
    <StripeProvider publishableKey={publishableKey} urlScheme={urlScheme}>
      <StripeDeepLinkBridge>{children}</StripeDeepLinkBridge>
    </StripeProvider>
  );
}

export function useClientStripeSheet() {
  return useStripe();
}
