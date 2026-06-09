import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncedPref } from '#hooks/useSyncedPref';

import { Setting } from './UI';

export function BankSyncSettings() {
  const { t } = useTranslation();
  const [clientId, setClientId] = useSyncedPref('truelayer-client-id');
  const [clientSecret, setClientSecret] =
    useSyncedPref('truelayer-client-secret');

  const [idInput, setIdInput] = useState(clientId || '');
  const [secretInput, setSecretInput] = useState(clientSecret || '');
  const [connections, setConnections] = useState<any[]>([]);

  // Update inputs if they are changed externally
  useEffect(() => {
    setIdInput(clientId || '');
    setSecretInput(clientSecret || '');
  }, [clientId, clientSecret]);

  useEffect(() => {
    async function fetchConnections() {
      if (clientId && clientSecret) {
        try {
          const results = await send('truelayer-get-connections');
          setConnections(Array.isArray(results) ? results : []);
        } catch (e) {
          console.error('Failed to fetch TrueLayer connections:', e);
        }
      }
    }
    fetchConnections();
  }, [clientId, clientSecret]);

  function onSave() {
    setClientId(idInput);
    setClientSecret(secretInput);
  }

  async function onDisconnect(id: string, name: string) {
    if (
      window.confirm(
        t('Are you sure you want to disconnect {{name}}?', { name }),
      )
    ) {
      await send('truelayer-disconnect', { connectionId: id });
      const results = await send('truelayer-get-connections');
      setConnections(Array.isArray(results) ? results : []);
      alert(t('Disconnected successfully.'));
    }
  }

  async function onResetAll() {
    if (
      window.confirm(
        t(
          'Are you sure you want to disconnect ALL TrueLayer bank connections? Your Client ID and Secret will be kept.',
        ),
      )
    ) {
      await send('truelayer-disconnect', { connectionId: 'all' });
      setConnections([]);
      alert(t('All connections have been reset.'));
    }
  }

  return (
    <>
      <Setting
        primaryAction={
          <Button onPress={onSave}>
            <Trans>Save</Trans>
          </Button>
        }
      >
        <Text>
          <strong>
            <Trans>TrueLayer Bank Sync</Trans>
          </strong>
        </Text>
        <Text>
          <Trans>
            Enter your TrueLayer credentials to sync your bank accounts
            directly from your client. Note: These secrets will be synced
            across your devices.
          </Trans>
        </Text>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column' }}>
            <Text style={{ marginBottom: 5 }}>
              <Trans>Client ID</Trans>
            </Text>
            <Input
              value={idInput}
              onChange={e => setIdInput(e.target.value)}
              type="text"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column' }}>
            <Text style={{ marginBottom: 5 }}>
              <Trans>Client Secret</Trans>
            </Text>
            <Input
              value={secretInput}
              onChange={e => setSecretInput(e.target.value)}
              type="password"
            />
          </label>
        </div>
      </Setting>

      {connections.length > 0 && (
        <Setting
          primaryAction={
            <Button onPress={onResetAll}>
              <Trans>Reset All</Trans>
            </Button>
          }
        >
          <Text>
            <strong>
              <Trans>TrueLayer Connections</Trans>
            </strong>
          </Text>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              width: '100%',
              marginTop: 10,
            }}
          >
            {connections.map(conn => (
              <div
                key={conn.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px',
                  backgroundColor: theme.tableBackground,
                  borderRadius: 4,
                  border: `1px solid ${theme.tableBorder}`,
                }}
              >
                <div>
                  <Text style={{ fontWeight: 'bold' }}>
                    {conn.fullName || conn.providerId}
                  </Text>
                  <Text
                    style={{
                      fontSize: '0.8em',
                      color: theme.pageTextSubdued,
                      display: 'block',
                    }}
                  >
                    {conn.id}
                  </Text>
                </div>
                <Button
                  variant="bare"
                  onPress={() =>
                    onDisconnect(conn.id, conn.fullName || conn.providerId)
                  }
                  style={{ color: theme.errorText }}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              </div>
            ))}
          </div>
        </Setting>
      )}
    </>
  );
}
