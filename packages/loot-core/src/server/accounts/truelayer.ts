import * as db from '#server/db';
import { logger } from '#platform/server/log';
import { post } from '#server/post';
import { getServer } from '#server/server-config';

const BASE_URL = 'https://api.truelayer.com/data/v1';
const AUTH_URL = 'https://auth.truelayer.com/connect/token';
const NETWORK_TIMEOUT = 30000;

export type TrueLayerMe = {
  credentials_id: string;
  client_id: string;
  provider: {
    display_name: string;
    provider_id: string;
    logo_uri?: string;
  };
};

export type TrueLayerAccount = {
  update_timestamp: string;
  account_id: string;
  account_type: 'TRANSACTION' | 'SAVINGS' | 'BUSINESS_TRANSACTION' | 'BUSINESS_SAVINGS';
  currency: string;
  display_name: string;
  account_number: {
    number?: string;
    sort_code?: string;
    swift_bic?: string;
    iban?: string;
    routing_number?: string;
    bsb?: string;
  };
  provider: {
    provider_id: string;
  };
};

export type TrueLayerCard = {
  account_id: string;
  card_network: string;
  card_type: string;
  currency: string;
  display_name: string;
  partial_card_number: string;
  name_on_card: string;
  valid_from?: string;
  valid_to?: string;
  update_timestamp: string;
  provider: {
    provider_id: string;
  };
};

export type TrueLayerTransaction = {
  transaction_id: string;
  normalised_provider_transaction_id?: string;
  provider_transaction_id?: string;
  timestamp: string;
  description: string;
  amount: number;
  currency: string;
  transaction_type: 'DEBIT' | 'CREDIT';
  transaction_category: string;
  transaction_classification: string[];
  merchant_name?: string;
  running_balance?: {
    amount?: number;
    currency?: string;
  };
  meta?: {
    provider_transaction_category?: string;
    provider_reference?: string;
    provider_merchant_name?: string;
    provider_category?: string;
    address?: string;
    provider_id?: string;
    counter_party_preferred_name?: string;
    counter_party_iban?: string;
    user_comments?: string;
    debtor_account_name?: string;
    provider_source?: string;
  };
};

export class TrueLayerError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  url: string,
  options: RequestInit,
  accessToken: string,
  connectionId?: string,
  isRetry = false,
): Promise<T> {
  const server = getServer();
  if (!server) {
    throw new Error('Server not configured');
  }

  try {
    const result = await post(server.TRUELAYER_SERVER + '/proxy', {
      url,
      method: options.method || 'GET',
      body: options.body,
      token: accessToken,
    });

    return result as T;
  } catch (err: any) {
    if (err?.status === 401 && !isRetry) {
      // Token expired, attempt refresh
      logger.info(
        `TrueLayer token expired for ${connectionId || 'default'}, attempting to refresh...`,
      );
      const newToken = await refreshTrueLayerToken(connectionId);
      if (newToken) {
        return request<T>(url, options, newToken, connectionId, true);
      }
    }
    throw err;
  }
}

export async function getConnections(): Promise<string[]> {
  const row = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-all-connections'",
  );
  if (!row?.value) {
    // Migration: check if legacy token exists
    const legacyToken = await db.first(
      "SELECT value FROM preferences WHERE id = 'truelayer-access-token'",
    );
    return legacyToken ? ['legacy'] : [];
  }
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return [];
  }
}

export async function addConnection(connectionId: string): Promise<void> {
  const connections = await getConnections();
  if (!connections.includes(connectionId)) {
    connections.push(connectionId);
    await db.run(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('truelayer-all-connections', ?)",
      [JSON.stringify(connections)],
    );
  }
}

export async function removeConnection(connectionId: string): Promise<void> {
  const connections = await getConnections();
  const updatedConnections = connections.filter(id => id !== connectionId);
  await db.run(
    "INSERT OR REPLACE INTO preferences (id, value) VALUES ('truelayer-all-connections', ?)",
    [JSON.stringify(updatedConnections)],
  );

  const suffix = getPrefSuffix(connectionId);
  await db.run("DELETE FROM preferences WHERE id = ?", [
    `truelayer-access-token${suffix}`,
  ]);
  await db.run("DELETE FROM preferences WHERE id = ?", [
    `truelayer-refresh-token${suffix}`,
  ]);
  await db.run("DELETE FROM preferences WHERE id = ?", [
    `truelayer-expires-at${suffix}`,
  ]);
}

export function getPrefSuffix(connectionId?: string) {
  if (!connectionId || connectionId === 'legacy') return '';
  // Sanitize ID for use in preference keys (remove slashes, equals, etc)
  return `-${connectionId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export async function refreshTrueLayerToken(
  connectionId?: string,
): Promise<string | null> {
  const suffix = getPrefSuffix(connectionId);
  const clientIdRow = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-id'",
  );
  const clientSecretRow = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-secret'",
  );
  const refreshTokenRow = await db.first<{ value: string }>(
    `SELECT value FROM preferences WHERE id = 'truelayer-refresh-token${suffix}'`,
  );

  const clientId = clientIdRow?.value;
  const clientSecret = clientSecretRow?.value;
  let refreshToken = refreshTokenRow?.value;

  // Auto-repair: If sanitized key missing, check for unsanitized key
  if (!refreshToken && connectionId && connectionId !== 'legacy') {
    const rawRow = await db.first<{ value: string }>(
      `SELECT value FROM preferences WHERE id = 'truelayer-refresh-token-${connectionId}'`,
    );
    if (rawRow?.value) {
      refreshToken = rawRow.value;
      logger.info(`Auto-repairing TrueLayer refresh token key for ${connectionId}`);
    }
  }

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn(
      `TrueLayer secrets or refresh token not configured for ${connectionId || 'default'} (key suffix: ${suffix}).`,
    );
    return null;
  }

  const server = getServer();
  if (!server) {
    throw new Error('Server not configured');
  }

  try {
    const data = (await post(server.TRUELAYER_SERVER + '/refresh', {
      clientId,
      clientSecret,
      refreshToken,
    })) as { access_token: string; refresh_token: string; expires_in: number };

    if (!data) {
      return null;
    }

    const { access_token, refresh_token, expires_in } = data;
    const expiresAt = Date.now() + expires_in * 1000;

    await db.run(
      `INSERT OR REPLACE INTO preferences (id, value) VALUES ('truelayer-access-token${suffix}', ?)`,
      [access_token],
    );
    await db.run(
      `INSERT OR REPLACE INTO preferences (id, value) VALUES ('truelayer-refresh-token${suffix}', ?)`,
      [refresh_token],
    );
    await db.run(
      `INSERT OR REPLACE INTO preferences (id, value) VALUES ('truelayer-expires-at${suffix}', ?)`,
      [expiresAt.toString()],
    );

    return access_token;
  } catch (err: any) {
    logger.error(
      `Unexpected error during TrueLayer refresh for ${connectionId || 'default'}:`,
      err,
    );
    return null;
  }
}

export async function getTrueLayerToken(
  connectionId?: string,
): Promise<string | null> {
  const suffix = getPrefSuffix(connectionId);
  const expiresAtRow = await db.first<{ value: string }>(
    `SELECT value FROM preferences WHERE id = 'truelayer-expires-at${suffix}'`,
  );
  let expiresAtStr = expiresAtRow?.value;

  // Auto-repair check
  if (!expiresAtStr && connectionId && connectionId !== 'legacy') {
    const rawRow = await db.first<{ value: string }>(
      `SELECT value FROM preferences WHERE id = 'truelayer-expires-at-${connectionId}'`,
    );
    expiresAtStr = rawRow?.value;
  }

  const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

  if (Date.now() >= expiresAt - 60000) {
    // Refresh if within 1 minute of expiring
    logger.info(
      `TrueLayer token proactively refreshing for ${connectionId || 'default'}...`,
    );
    return refreshTrueLayerToken(connectionId);
  }

  const accessTokenRow = await db.first<{ value: string }>(
    `SELECT value FROM preferences WHERE id = 'truelayer-access-token${suffix}'`,
  );
  let accessToken = accessTokenRow?.value;

  // Auto-repair check
  if (!accessToken && connectionId && connectionId !== 'legacy') {
    const rawRow = await db.first<{ value: string }>(
      `SELECT value FROM preferences WHERE id = 'truelayer-access-token-${connectionId}'`,
    );
    accessToken = rawRow?.value;
  }

  return accessToken || null;
}

export async function getMe(connectionId?: string): Promise<TrueLayerMe> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const res = await request<{ results: TrueLayerMe[] }>(
    `${BASE_URL}/me`,
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results[0];
}

export async function listAccounts(
  connectionId?: string,
): Promise<TrueLayerAccount[]> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const res = await request<{ results: TrueLayerAccount[] }>(
    `${BASE_URL}/accounts`,
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results;
}

export async function listCards(
  connectionId?: string,
): Promise<TrueLayerCard[]> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const res = await request<{ results: TrueLayerCard[] }>(
    `${BASE_URL}/cards`,
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results;
}

export type TrueLayerBalance = {
  currency: string;
  available: number;
  current: number;
  overdraft?: number;
  update_timestamp: string;
};

export async function getAccountBalance(
  accountId: string,
  connectionId?: string,
): Promise<TrueLayerBalance> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const res = await request<{ results: TrueLayerBalance[] }>(
    `${BASE_URL}/accounts/${accountId}/balance`,
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results[0];
}

export async function getCardBalance(
  cardId: string,
  connectionId?: string,
): Promise<TrueLayerBalance> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const res = await request<{ results: TrueLayerBalance[] }>(
    `${BASE_URL}/cards/${cardId}/balance`,
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results[0];
}

export async function getAccountTransactions(
  accountId: string,
  from?: string,
  connectionId?: string,
): Promise<TrueLayerTransaction[]> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const url = new URL(`${BASE_URL}/accounts/${accountId}/transactions`);
  if (from) {
    url.searchParams.append('from', from);
  }

  const res = await request<{ results: TrueLayerTransaction[] }>(
    url.toString(),
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results;
}

export async function getCardTransactions(
  cardId: string,
  from?: string,
  connectionId?: string,
): Promise<TrueLayerTransaction[]> {
  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  const url = new URL(`${BASE_URL}/cards/${cardId}/transactions`);
  if (from) {
    url.searchParams.append('from', from);
  }

  const res = await request<{ results: TrueLayerTransaction[] }>(
    url.toString(),
    { method: 'GET' },
    token,
    connectionId,
  );
  return res.results;
}

export async function downloadTrueLayerTransactions(
  accountId: string,
  from?: string,
  connectionId?: string,
) {
  const [type, id] = accountId.split(':');
  let truelayerTransactions: TrueLayerTransaction[] = [];
  let currentBalance = 0;

  const token = await getTrueLayerToken(connectionId);
  if (!token) throw new Error('No access token');

  if (type === 'card') {
    const [transactions, balance] = await Promise.all([
      getCardTransactions(id, from, connectionId),
      request<{ results: { current: number }[] }>(
        `${BASE_URL}/cards/${id}/balance`,
        { method: 'GET' },
        token,
        connectionId,
      ),
    ]);

    if (transactions && Array.isArray((transactions as any).results)) {
      truelayerTransactions = (transactions as any).results;
    } else if (Array.isArray(transactions)) {
      truelayerTransactions = transactions;
    }

    currentBalance =
      (balance as any).results?.[0]?.current ||
      (balance as any)[0]?.current ||
      0;
  } else {
    // Default to account
    const [transactions, balance] = await Promise.all([
      request<{ results: TrueLayerTransaction[] }>(
        `${BASE_URL}/accounts/${id}/transactions${from ? `?from=${from}` : ''}`,
        { method: 'GET' },
        token,
        connectionId,
      ),
      request<{ results: { current: number }[] }>(
        `${BASE_URL}/accounts/${id}/balance`,
        { method: 'GET' },
        token,
        connectionId,
      ),
    ]);

    if (transactions && Array.isArray((transactions as any).results)) {
      truelayerTransactions = (transactions as any).results;
    } else if (Array.isArray(transactions)) {
      truelayerTransactions = transactions as unknown as TrueLayerTransaction[];
    }

    currentBalance =
      (balance as any).results?.[0]?.current ||
      (balance as any)[0]?.current ||
      0;
  }

  const mappedTransactions = (truelayerTransactions || []).map(t => {
    const amount =
      t.transaction_type === 'DEBIT' ? -Math.abs(t.amount) : Math.abs(t.amount);
    return {
      transactionId: t.transaction_id,
      date: t.timestamp.split('T')[0],
      payeeName: t.merchant_name || t.description,
      notes: t.description,
      amount,
      transactionAmount: { amount },
      booked: true,
    };
  });

  return {
    transactions: mappedTransactions,
    balances: [],
    startingBalance: Math.round(currentBalance * 100),
  };
}
