import express from 'express';
import { requestLoggerMiddleware } from '#util/middlewares';

const app = express();
app.use(requestLoggerMiddleware);
app.use(express.json());

app.post('/exchange', async (req, res) => {
  const { code, redirectUri, clientId, clientSecret } = req.body;

  console.log('[TrueLayer Server] Starting exchange for code:', code?.substring(0, 10) + '...');
  try {
    const response = await fetch('https://auth.truelayer.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[TrueLayer Server] Exchange failed:', {
        status: response.status,
        data,
      });
      return res.send({
        status: 'error',
        reason: data.error_description || data.error || 'Exchange failed',
        data,
      });
    }
    console.log('[TrueLayer Server] Exchange successful');
    res.send({
      status: 'ok',
      data,
    });
  } catch (err) {
    console.error('[TrueLayer Server] Unexpected error:', err);
    res.send({
      status: 'error',
      reason: err.message,
    });
  }
});

app.post('/refresh', async (req, res) => {
  const { clientId, clientSecret, refreshToken } = req.body;

  console.log('[TrueLayer Server] Refreshing token...');
  try {
    const response = await fetch('https://auth.truelayer.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[TrueLayer Server] Refresh failed:', {
        status: response.status,
        data,
      });
      return res.send({
        status: 'error',
        reason: data.error_description || data.error || 'Refresh failed',
        data,
      });
    }
    console.log('[TrueLayer Server] Refresh successful');
    res.send({
      status: 'ok',
      data,
    });
  } catch (err) {
    console.error('[TrueLayer Server] Unexpected error:', err);
    res.send({
      status: 'error',
      reason: err.message,
    });
  }
});

app.post('/proxy', async (req, res) => {
  const { url, method, body, token } = req.body;

  console.log(`[TrueLayer Server] Proxying ${method || 'GET'} to ${url}`);
  try {
    const response = await fetch(url, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      data = { text: responseText };
    }

    if (!response.ok) {
      console.error('[TrueLayer Server] Proxy request failed:', {
        status: response.status,
        url,
        data,
      });
      return res.send({
        status: 'error',
        reason: data.error_description || data.error || 'Proxy request failed',
        data,
      });
    }
    res.send({
      status: 'ok',
      data,
    });
  } catch (err) {
    console.error('[TrueLayer Server] Proxy exception:', err);
    res.send({
      status: 'error',
      reason: err.message,
    });
  }
});

export { app as handlers };
