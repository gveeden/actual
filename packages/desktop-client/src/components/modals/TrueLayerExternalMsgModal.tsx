import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useDispatch } from '#redux';
import { pushModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';

type TrueLayerExternalMsgModalProps = {
  onSuccess?: () => void;
  onClose?: () => void;
};

export function TrueLayerExternalMsgModal({
  onSuccess,
  onClose,
}: TrueLayerExternalMsgModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const [clientId] = useSyncedPref('truelayer-client-id');
  const [clientSecret] = useSyncedPref('truelayer-client-secret');

  const isConfigured = !!clientId && !!clientSecret;

  const onJump = () => {
    const redirectUri = window.location.origin + '/truelayer/auth_callback';
    const state = Math.random().toString(36).substring(7);
    localStorage.setItem('truelayer_auth_state', state);

    const authUrl = new URL('https://auth.truelayer.com/');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', clientId || '');
    authUrl.searchParams.append('scope', 'info accounts balance cards transactions direct_debits standing_orders offline_access');
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('providers', 'uk-ob-all uk-oauth-all uk-cs-all ie-ob-all');
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('enable_reselection', 'true');
    authUrl.searchParams.append('enable_account_selection', 'true');

    window.open(authUrl.toString(), '_blank');

    // Start polling for successful authentication
    const interval = setInterval(async () => {
      try {
        const status = await send('truelayer-auth-status');
        if (status === 'authenticated') {
          clearInterval(interval);
          onSuccess?.();
        }
      } catch (err) {
        console.error('Error polling TrueLayer status:', err);
      }
    }, 2000);

    // Clean up interval on close
    const originalOnClose = onClose;
    onClose = () => {
      clearInterval(interval);
      originalOnClose?.();
    };
  };

  return (
    <Modal
      name="truelayer-external-msg"
      onClose={onClose}
      containerProps={{ style: { width: '30vw' } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Link Your Bank via TrueLayer')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View>
            <Paragraph style={{ fontSize: 15 }}>
              <Trans>
                To link your bank account, you will be redirected to TrueLayer to securely authenticate with your bank.
                Actual will not be able to withdraw funds from your accounts.
              </Trans>
            </Paragraph>

            {isConfigured ? (
              <View style={{ marginTop: 20 }}>
                <Button
                  variant="primary"
                  autoFocus
                  style={{
                    padding: '10px 0',
                    fontSize: 15,
                    fontWeight: 600,
                  }}
                  onPress={onJump}
                >
                  <Trans>Link bank in browser</Trans> &rarr;
                </Button>
              </View>
            ) : (
              <View style={{ marginTop: 20 }}>
                <Paragraph style={{ color: theme.errorText }}>
                  <Trans>
                    TrueLayer integration has not yet been configured. You need to set your Client ID and Client Secret in Settings.
                  </Trans>
                </Paragraph>
                <Button 
                  variant="primary" 
                  onPress={() => {
                    state.close();
                    window.location.hash = '/settings'; // Simplistic jump, though better handled by navigation
                  }}
                >
                  <Trans>Go to Settings</Trans>
                </Button>
              </View>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
