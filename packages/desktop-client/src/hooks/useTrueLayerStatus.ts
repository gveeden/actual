import { useEffect, useState } from 'react';
import { send } from '@actual-app/core/platform/client/connection';

export function useTrueLayerStatus() {
  const [configuredTrueLayer, setConfiguredTrueLayer] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);
      const status = await send('truelayer-status');
      setConfiguredTrueLayer(status === 'connected');
      setIsLoading(false);
    }
    void fetch();
  }, []);

  return {
    configuredTrueLayer,
    isLoading,
  };
}
