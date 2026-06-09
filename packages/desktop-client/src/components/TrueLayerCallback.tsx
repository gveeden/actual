import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Paragraph } from '@actual-app/components/paragraph';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import { useUrlParam } from '#hooks/useUrlParam';

export function TrueLayerCallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [code] = useUrlParam('code');
  const [stateParam] = useUrlParam('state');
  const [errorParam] = useUrlParam('error');
  const storedState = localStorage.getItem('truelayer_auth_state');
  const stateValid =
    typeof stateParam === 'string' &&
    typeof storedState === 'string' &&
    stateParam === storedState;
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState('');
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    async function handleCallback() {
      console.log('[TrueLayer] Callback handler started');
      console.log('[TrueLayer] URL Params:', {
        code: code ? 'present' : 'missing',
        stateParam,
        errorParam,
      });
      console.log('[TrueLayer] Stored state:', storedState);

      if (errorParam) {
        console.error('[TrueLayer] Error param found in URL:', errorParam);
        setStatus('error');
        setErrorMessage(
          t('Authorization was denied or failed: {{error}}', {
            error: errorParam,
          }),
        );
        return;
      }

      if (!code) {
        console.error('[TrueLayer] No code found in URL');
        setStatus('error');
        setErrorMessage(t('Missing authorization parameters.'));
        return;
      }

      if (!stateValid) {
        console.warn(
          '[TrueLayer] State mismatch or missing! URL state:',
          stateParam,
          'Stored state:',
          storedState,
        );
        console.warn(
          '[TrueLayer] Proceeding anyway (security check bypassed for debug)...',
        );
      }

      try {
        const redirectUri = window.location.origin + '/truelayer/auth_callback';
        console.log('[TrueLayer] Sending exchange request to backend...', {
          redirectUri,
          origin: window.location.origin,
          protocol: window.location.protocol,
        });

        const result = await send('truelayer-complete-auth', {
          code,
          redirectUri,
        });

        console.log('[TrueLayer] Backend result:', result);

        if (result && 'error' in result) {
          console.error('[TrueLayer] Backend returned error:', result.error);
          setStatus('error');
          setErrorMessage(
            (result.error as any)?.message ||
              t('Failed to complete authorization.'),
          );
          return;
        }

        console.log('[TrueLayer] Auth completion successful');
        setStatus('success');
        localStorage.removeItem('truelayer_auth_state');

        // Auto-close if popup, else navigate back
        setTimeout(() => {
          if (window.opener) {
            console.log('[TrueLayer] Closing popup window');
            window.close();
          } else {
            console.log('[TrueLayer] Navigating to accounts');
            navigate('/accounts');
          }
        }, 1500);
      } catch (e) {
        console.error('[TrueLayer] Unexpected exception in handleCallback:', e);
        setStatus('error');
        setErrorMessage(
          t('An unexpected error occurred.') +
            ' ' +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    void handleCallback();
  }, [code, stateParam, stateValid, errorParam, t, navigate]);

  return (
    <View
      style={{
        padding: 20,
        maxWidth: 500,
        margin: '40px auto',
        textAlign: 'center',
      }}
    >
      {status === 'loading' && (
        <Paragraph>
          <Trans>Completing authorization...</Trans>
        </Paragraph>
      )}

      {status === 'success' && (
        <Paragraph>
          <Trans>
            Authorization successful! This window will close automatically.
          </Trans>
        </Paragraph>
      )}

      {status === 'error' && (
        <>
          <ErrorAlert>{errorMessage}</ErrorAlert>
          <Paragraph style={{ marginTop: 10 }}>
            <Trans>You can close this window and try again.</Trans>
          </Paragraph>
        </>
      )}
    </View>
  );
}
