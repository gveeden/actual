import { v4 as uuidv4 } from 'uuid';

import { captureException } from '#platform/exceptions';
import * as asyncStorage from '#platform/server/asyncStorage';
import * as connection from '#platform/server/connection';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import * as db from '#server/db';
import {
  APIError,
  BankSyncError,
  PostError,
  TransactionError,
} from '#server/errors';
import { app as mainApp } from '#server/main-app';
import { mutator } from '#server/mutators';
import { get, post } from '#server/post';
import { getServer } from '#server/server-config';
import { batchMessages } from '#server/sync';
import { undoable, withUndo } from '#server/undo';
import { isNonProductionEnvironment } from '#shared/environment';
import { dayFromDate } from '#shared/months';
import * as monthUtils from '#shared/months';
import { amountToInteger } from '#shared/util';
import type { ImportTransactionsOpts } from '#types/api-handlers';
import type {
  AccountEntity,
  BankSyncStatus,
  CategoryEntity,
  GoCardlessToken,
  ImportTransactionEntity,
  SyncServerAkahuAccount,
  SyncServerEnableBankingAccount,
  SyncServerGoCardlessAccount,
  SyncServerPluggyAiAccount,
  SyncServerSimpleFinAccount,
  SyncServerTrueLayerAccount,
  TransactionEntity,
} from '#types/models';

import * as link from './link';
import { getStartingBalancePayee } from './payees';
import * as bankSync from './sync';
import * as truelayer from './truelayer';

// Shared base type for link account parameters
type LinkAccountBaseParams = {
  upgradingId?: AccountEntity['id'];
  offBudget?: boolean;
  startingDate?: string;
  startingBalance?: number;
};

export type AccountHandlers = {
  'account-update': typeof updateAccount;
  'accounts-get': typeof getAccounts;
  'account-balance': typeof getAccountBalance;
  'account-properties': typeof getAccountProperties;
  'gocardless-accounts-link': typeof linkGoCardlessAccount;
  'simplefin-accounts-link': typeof linkSimpleFinAccount;
  'truelayer-accounts-link': typeof linkTrueLayerAccount;
  'pluggyai-accounts-link': typeof linkPluggyAiAccount;
  'akahu-accounts-link': typeof linkAkahuAccount;
  'enablebanking-accounts-link': typeof linkEnableBankingAccount;
  'account-create': typeof createAccount;
  'account-close': typeof closeAccount;
  'account-reopen': typeof reopenAccount;
  'account-move': typeof moveAccount;
  'secret-set': typeof setSecret;
  'secret-check': typeof checkSecret;
  'gocardless-poll-web-token': typeof pollGoCardlessWebToken;
  'gocardless-poll-web-token-stop': typeof stopGoCardlessWebTokenPolling;
  'gocardless-status': typeof goCardlessStatus;
  'simplefin-status': typeof simpleFinStatus;
  'truelayer-status': typeof trueLayerStatus;
  'truelayer-auth-status': typeof trueLayerAuthStatus;
  'pluggyai-status': typeof pluggyAiStatus;
  'akahu-status': typeof akahuStatus;
  'enablebanking-status': typeof enableBankingStatus;
  'enablebanking-aspsps': typeof enableBankingAspsps;
  'enablebanking-start-auth': typeof enableBankingStartAuth;
  'enablebanking-complete-auth': typeof enableBankingCompleteAuth;
  'enablebanking-poll-auth': typeof enableBankingPollAuth;
  'enablebanking-poll-auth-stop': typeof stopEnableBankingPollAuth;
  'enablebanking-configure': typeof enableBankingConfigure;
  'truelayer-complete-auth': typeof trueLayerCompleteAuth;
  'simplefin-accounts': typeof simpleFinAccounts;
  'truelayer-accounts': typeof trueLayerAccounts;
  'pluggyai-accounts': typeof pluggyAiAccounts;
  'akahu-accounts': typeof akahuAccounts;
  'gocardless-get-banks': typeof getGoCardlessBanks;
  'gocardless-create-web-token': typeof createGoCardlessWebToken;
  'accounts-bank-sync': typeof accountsBankSync;
  'simplefin-batch-sync': typeof simpleFinBatchSync;
  'truelayer-batch-sync': typeof trueLayerBatchSync;
  'truelayer-disconnect': typeof trueLayerDisconnect;
  'truelayer-get-connections': typeof trueLayerGetConnections;
  'transactions-import': typeof importTransactions;
  'account-unlink': typeof unlinkAccount;
};

async function updateAccount({
  id,
  name,
  last_reconciled,
}: Pick<AccountEntity, 'id' | 'name'> &
  Partial<Pick<AccountEntity, 'last_reconciled'>>) {
  await db.update('accounts', {
    id,
    name,
    ...(last_reconciled && { last_reconciled }),
  });
  return {};
}

async function getAccounts(): Promise<AccountEntity[]> {
  const dbAccounts = await db.getAccounts();
  return dbAccounts.map(
    dbAccount =>
      ({
        id: dbAccount.id,
        name: dbAccount.name,
        offbudget: dbAccount.offbudget,
        closed: dbAccount.closed,
        sort_order: dbAccount.sort_order,
        last_reconciled: dbAccount.last_reconciled ?? null,
        tombstone: dbAccount.tombstone,
        account_id: dbAccount.account_id ?? null,
        bank: dbAccount.bank ?? null,
        bankName: dbAccount.bankName ?? null,
        bankId: dbAccount.bankId ?? null,
        mask: dbAccount.mask ?? null,
        official_name: dbAccount.official_name ?? null,
        balance_current: dbAccount.balance_current ?? null,
        balance_available: dbAccount.balance_available ?? null,
        balance_limit: dbAccount.balance_limit ?? null,
        account_sync_source: dbAccount.account_sync_source ?? null,
        last_sync: dbAccount.last_sync ?? null,
        bank_sync_status: dbAccount.bank_sync_status ?? null,
      }) satisfies AccountEntity,
  );
}

async function getAccountBalance({
  id,
  cutoff,
}: {
  id: string;
  cutoff: string | Date;
}) {
  const result = await db.first<{ balance: number }>(
    'SELECT sum(amount) as balance FROM transactions WHERE acct = ? AND isParent = 0 AND tombstone = 0 AND date <= ?',
    [id, db.toDateRepr(dayFromDate(cutoff))],
  );
  return result?.balance ? result.balance : 0;
}

async function getAccountProperties({ id }: { id: AccountEntity['id'] }) {
  const balanceResult = await db.first<{ balance: number }>(
    'SELECT sum(amount) as balance FROM transactions WHERE acct = ? AND isParent = 0 AND tombstone = 0',
    [id],
  );
  const countResult = await db.first<{ count: number }>(
    'SELECT count(id) as count FROM transactions WHERE acct = ? AND tombstone = 0',
    [id],
  );

  return {
    balance: balanceResult?.balance || 0,
    numTransactions: countResult?.count || 0,
  };
}

async function linkGoCardlessAccount({
  requisitionId,
  account,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  requisitionId: string;
  account: SyncServerGoCardlessAccount;
}) {
  let id;
  const bank = await link.findOrCreateBank(account.institution, requisitionId);

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: account.account_id,
      bank: bank.id,
      account_sync_source: 'goCardless',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: account.account_id,
      mask: account.mask,
      name: account.name,
      official_name: account.official_name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'goCardless',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    account.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions', 'accounts'],
  });

  return 'ok';
}

async function linkSimpleFinAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerSimpleFinAccount;
}) {
  let id;

  const institution = {
    // Persist a null name when the provider doesn't report an institution, so
    // the desktop-client can render a localized fallback instead of baking an
    // English string into shared bank data.
    name: externalAccount.institution ?? null,
  };

  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.orgDomain ?? externalAccount.orgId,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'simpleFin',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions', 'accounts'],
  });

  return 'ok';
}

async function linkPluggyAiAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerPluggyAiAccount;
}) {
  let id;

  const institution = {
    // Persist a null name when the provider doesn't report an institution, so
    // the desktop-client can render a localized fallback instead of baking an
    // English string into shared bank data.
    name: externalAccount.institution ?? null,
  };

  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.orgDomain ?? externalAccount.orgId,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'pluggyai',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'pluggyai',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions', 'accounts'],
  });

  return 'ok';
}

async function linkAkahuAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerAkahuAccount;
}) {
  let id;

  const institution = {
    name: externalAccount.institution ?? null,
  };

  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.orgDomain ?? externalAccount.orgId,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'akahu',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'akahu',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions'],
  });

  return 'ok';
}

async function linkEnableBankingAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerEnableBankingAccount;
}) {
  let id: string | undefined;

  const institution = {
    // Persist a null name when the provider doesn't report an institution, so
    // the desktop-client can render a localized fallback instead of baking an
    // English string into shared bank data.
    name: externalAccount.institution ?? null,
  };

  // Enable Banking uses a session-per-account model, so we use the
  // account-level identifier (account_id) rather than institution-level
  // IDs. This creates one bank entry per Enable Banking account, unlike
  // GoCardless (requisitionId) or SimpleFin/PluggyAi (orgDomain/orgId).
  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.account_id,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'enableBanking',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'enableBanking',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  if (id == null) {
    throw new Error('id was not assigned in linkEnableBankingAccount');
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions', 'accounts'],
  });

  return 'ok';
}

async function createAccount({
  name,
  balance = 0,
  offBudget = false,
  closed = false,
}: {
  name: string;
  balance?: number | undefined;
  offBudget?: boolean | undefined;
  closed?: boolean | undefined;
}) {
  const id: AccountEntity['id'] = await db.insertAccount({
    name,
    offbudget: offBudget ? 1 : 0,
    closed: closed ? 1 : 0,
  });

  await db.insertPayee({
    name: '',
    transfer_acct: id,
  });

  if (balance != null && balance !== 0) {
    const payee = await getStartingBalancePayee();

    await db.insertTransaction({
      account: id,
      amount: amountToInteger(balance),
      category: offBudget ? null : payee.category,
      payee: payee.id,
      date: monthUtils.currentDay(),
      cleared: true,
      starting_balance_flag: true,
    });
  }

  return id;
}

async function closeAccount({
  id,
  transferAccountId,
  categoryId,
  forced = false,
}: {
  id: AccountEntity['id'];
  transferAccountId?: AccountEntity['id'] | undefined;
  categoryId?: CategoryEntity['id'] | undefined;
  forced?: boolean | undefined;
}) {
  // Unlink the account if it's linked. This makes sure to remove it from
  // bank-sync providers. (This should not be undo-able, as it mutates the
  // remote server and the user will have to link the account again)
  await unlinkAccount({ id });

  return withUndo(async () => {
    const account = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ? AND tombstone = 0',
      [id],
    );

    // Do nothing if the account doesn't exist or it's already been
    // closed
    if (!account || account.closed === 1) {
      return;
    }

    const { balance, numTransactions } = await getAccountProperties({ id });

    // If there are no transactions, we can simply delete the account
    if (numTransactions === 0) {
      await db.deleteAccount({ id });
    } else if (forced) {
      const rows = db.runQuery<
        Pick<db.DbViewTransaction, 'id' | 'transfer_id'>
      >(
        'SELECT id, transfer_id FROM v_transactions WHERE account = ?',
        [id],
        true,
      );

      const transferPayee = await db.first<Pick<db.DbPayee, 'id'>>(
        'SELECT id FROM payees WHERE transfer_acct = ?',
        [id],
      );

      if (!transferPayee) {
        throw new Error(`Transfer payee with account ID ${id} not found.`);
      }

      await batchMessages(async () => {
        // TODO: what this should really do is send a special message that
        // automatically marks the tombstone value for all transactions
        // within an account... or something? This is problematic
        // because another client could easily add new data that
        // should be marked as deleted.

        rows.forEach(row => {
          if (row.transfer_id) {
            void db.updateTransaction({
              id: row.transfer_id,
              payee: null,
              transfer_id: null,
            });
          }

          void db.deleteTransaction({ id: row.id });
        });

        void db.deleteAccount({ id });
        void db.deleteTransferPayee({ id: transferPayee.id });
      });
    } else {
      if (balance !== 0 && transferAccountId == null) {
        throw APIError('balance is non-zero: transferAccountId is required');
      }

      if (id === transferAccountId) {
        throw APIError('transfer account can not be the account being closed');
      }

      await db.update('accounts', { id, closed: 1 });

      // If there is a balance we need to transfer it to the specified
      // account (and possibly categorize it)
      if (balance !== 0 && transferAccountId) {
        const transferPayee = await db.first<Pick<db.DbPayee, 'id'>>(
          'SELECT id FROM payees WHERE transfer_acct = ?',
          [transferAccountId],
        );

        if (!transferPayee) {
          throw new Error(
            `Transfer payee with account ID ${transferAccountId} not found.`,
          );
        }

        await mainApp.handlers['transaction-add']({
          id: uuidv4(),
          payee: transferPayee.id,
          amount: -balance,
          account: id,
          date: monthUtils.currentDay(),
          notes: 'Closing account',
          category: categoryId,
        });
      }
    }
  });
}

async function reopenAccount({ id }: { id: AccountEntity['id'] }) {
  await db.update('accounts', { id, closed: 0 });
}

async function moveAccount({
  id,
  targetId,
}: {
  id: AccountEntity['id'];
  targetId: AccountEntity['id'] | null;
}) {
  await db.moveAccount(id, targetId);
}

async function setSecret({
  name,
  value,
}: {
  name: string;
  value: string | null;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.BASE_SERVER + '/secret',
      {
        name,
        value,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );
  } catch (error) {
    return {
      error: 'failed',
      reason: error instanceof PostError ? error.reason : undefined,
    };
  }
}
async function checkSecret(name: string) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await get(serverConfig.BASE_SERVER + '/secret/' + name, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (error) {
    logger.error(error);
    return { error: 'failed' };
  }
}

let stopPolling = false;

async function pollGoCardlessWebToken({
  requisitionId,
}: {
  requisitionId: string;
}) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'unknown' };

  const startTime = Date.now();
  stopPolling = false;

  async function getData(
    cb: (
      data:
        | { status: 'timeout' }
        | { status: 'unknown'; message?: string }
        | { status: 'success'; data: GoCardlessToken },
    ) => void,
  ) {
    if (stopPolling) {
      return;
    }

    if (Date.now() - startTime >= 1000 * 60 * 10) {
      cb({ status: 'timeout' });
      return;
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('Failed to get server config.');
    }

    const data = await post(
      serverConfig.GOCARDLESS_SERVER + '/get-accounts',
      {
        requisitionId,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );

    if (data) {
      if (data.error_code) {
        logger.error('Failed linking gocardless account:', data);
        cb({ status: 'unknown', message: data.error_type });
      } else {
        cb({ status: 'success', data });
      }
    } else {
      setTimeout(() => getData(cb), 3000);
    }
  }

  return new Promise(resolve => {
    void getData(data => {
      if (data.status === 'success') {
        resolve({ data: data.data });
        return;
      }

      if (data.status === 'timeout') {
        resolve({ error: data.status });
        return;
      }

      resolve({
        error: data.status,
        message: data.message,
      });
    });
  });
}

async function stopGoCardlessWebTokenPolling() {
  stopPolling = true;
  return 'ok';
}

async function goCardlessStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.GOCARDLESS_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function simpleFinStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.SIMPLEFIN_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function pluggyAiStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.PLUGGYAI_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function akahuStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.AKAHU_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function simpleFinAccounts() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.SIMPLEFIN_SERVER + '/accounts',
      {},
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      60000,
    );
  } catch {
    return { error_code: 'TIMED_OUT' };
  }
}

async function pluggyAiAccounts() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.PLUGGYAI_SERVER + '/accounts',
      {},
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      60000,
    );
  } catch {
    return { error_code: 'TIMED_OUT' };
  }
}

async function akahuAccounts() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.AKAHU_SERVER + '/accounts',
      {},
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      60000,
    );
  } catch {
    return { error_code: 'TIMED_OUT' };
  }
}

async function enableBankingStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.ENABLEBANKING_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function enableBankingAspsps(country: string) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.ENABLEBANKING_SERVER + '/aspsps',
    { country },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function enableBankingStartAuth({
  aspspId,
  country,
  redirectUrl,
  maxConsentValidity,
}: {
  aspspId: string;
  country: string;
  redirectUrl: string;
  maxConsentValidity?: number;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  if (
    maxConsentValidity !== undefined &&
    (!Number.isFinite(maxConsentValidity) ||
      !Number.isInteger(maxConsentValidity) ||
      maxConsentValidity <= 0 ||
      maxConsentValidity > 315_360_000)
  ) {
    return { error: 'invalid_max_consent_validity' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.ENABLEBANKING_SERVER + '/start-auth',
    { aspsp: { name: aspspId, country }, redirectUrl, maxConsentValidity },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function enableBankingCompleteAuth({
  code,
  state,
}: {
  code: string;
  state: string;
}) {
  if (!state) {
    return { error: 'missing-state' };
  }

  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.ENABLEBANKING_SERVER + '/complete-auth',
    { code, state },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function trueLayerCompleteAuth({
  code,
  redirectUri,
}: {
  code: string;
  redirectUri: string;
}) {
  logger.info('Starting TrueLayer token exchange...', { redirectUri });
  const clientIdRow = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-id'",
  );
  const clientSecretRow = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-secret'",
  );

  const clientId = clientIdRow?.value;
  const clientSecret = clientSecretRow?.value;

  if (!clientId || !clientSecret) {
    logger.error('TrueLayer credentials missing in DB');
    return { error: { message: 'TrueLayer credentials not configured.' } };
  }

  try {
    const server = getServer();
    if (!server) {
      throw new Error('Server not configured');
    }

    logger.info('Forwarding TrueLayer exchange to server...');
    const data = (await post(server.TRUELAYER_SERVER + '/exchange', {
      code,
      redirectUri,
      clientId,
      clientSecret,
    })) as { access_token: string; refresh_token: string; expires_in: number };

    if (!data) {
      throw new Error('Failed to exchange TrueLayer tokens');
    }

    const { access_token, refresh_token, expires_in } = data;
    const expiresAt = Date.now() + expires_in * 1000;

    // Use /me endpoint to get credentials_id as connectionId
    const meRes = (await post(server.TRUELAYER_SERVER + '/proxy', {
      url: 'https://api.truelayer.com/data/v1/me',
      method: 'GET',
      token: access_token,
    })) as { results: { credentials_id: string }[] };

    if (!meRes?.results?.[0]) {
      throw new Error('Failed to fetch TrueLayer identity');
    }

    const connectionId = meRes.results[0].credentials_id;
    const suffix = truelayer.getPrefSuffix(connectionId);

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

    await truelayer.addConnection(connectionId);

    logger.info(`TrueLayer tokens saved successfully for ${connectionId}`);
    return {};
  } catch (err) {
    logger.error('TrueLayer auth exchange failed:', err);
    return {
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

const enableBankingPollControllers = new Map<string, AbortController>();

async function enableBankingPollAuth({ state }: { state: string }) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  const controller = new AbortController();
  enableBankingPollControllers.set(state, controller);

  try {
    return await post(
      serverConfig.ENABLEBANKING_SERVER + '/poll-auth',
      { state },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      310000, // slightly longer than server's 5-minute poll timeout
      controller.signal,
    );
  } finally {
    if (enableBankingPollControllers.get(state) === controller) {
      enableBankingPollControllers.delete(state);
    }
  }
}

async function stopEnableBankingPollAuth({ state }: { state: string }) {
  const controller = enableBankingPollControllers.get(state);
  if (controller) {
    controller.abort();
    enableBankingPollControllers.delete(state);
  }
  return 'ok';
}

async function enableBankingConfigure(config: {
  applicationId: string;
  secretKey: string;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(serverConfig.ENABLEBANKING_SERVER + '/configure', config, {
    'X-ACTUAL-TOKEN': userToken,
  });
}

async function getGoCardlessBanks(country: string) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.GOCARDLESS_SERVER + '/get-banks',
    { country, showDemo: isNonProductionEnvironment() },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function createGoCardlessWebToken({
  institutionId,
  accessValidForDays,
}: {
  institutionId: string;
  accessValidForDays: number;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.GOCARDLESS_SERVER + '/create-web-token',
      {
        institutionId,
        accessValidForDays,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );
  } catch (error) {
    logger.error(error);
    return { error: 'failed' };
  }
}

type SyncResponse = {
  newTransactions: Array<TransactionEntity['id']>;
  matchedTransactions: Array<TransactionEntity['id']>;
  updatedAccounts: Array<AccountEntity['id']>;
};

async function handleSyncResponse(
  res: {
    added: Array<TransactionEntity['id']>;
    updated: Array<TransactionEntity['id']>;
  },
  acctId: string,
): Promise<SyncResponse> {
  const { added, updated } = res;
  const newTransactions: Array<TransactionEntity['id']> = [];
  const matchedTransactions: Array<TransactionEntity['id']> = [];
  const updatedAccounts: Array<AccountEntity['id']> = [];

  newTransactions.push(...added);
  matchedTransactions.push(...updated);

  if (added.length > 0) {
    updatedAccounts.push(acctId);
  }

  const ts = new Date().getTime().toString();
  await db.update('accounts', {
    id: acctId,
    last_sync: ts,
    bank_sync_status: 'ok',
  });

  return {
    newTransactions,
    matchedTransactions,
    updatedAccounts,
  };
}

type SyncError =
  | {
      type: 'SyncError';
      accountId: AccountEntity['id'];
      message: string;
      category: string;
      code: string;
    }
  | {
      accountId: AccountEntity['id'];
      message: string;
      internal?: string;
    };

/**
 * Type guard to check if an error is a BankSyncError.
 * Handles both class instances and plain objects with the BankSyncError shape.
 */
function isBankSyncError(err: unknown): err is BankSyncError {
  return (
    err instanceof BankSyncError ||
    (typeof err === 'object' &&
      err !== null &&
      'type' in err &&
      err.type === 'BankSyncError')
  );
}

/**
 * Converts a sync error into a standardized SyncError response object.
 */
function handleSyncError(
  err: Error | PostError | BankSyncError,
  acct: db.DbAccount,
): SyncError {
  if (isBankSyncError(err)) {
    const syncError = {
      type: 'SyncError',
      accountId: acct.id,
      message: 'Failed syncing account "' + acct.name + '."',
      category: err.category,
      code: err.code,
    };

    if (err.category === 'RATE_LIMIT_EXCEEDED') {
      return {
        ...syncError,
        message: `Failed syncing account ${acct.name}. Rate limit exceeded. Please try again later.`,
      };
    }

    return syncError;
  }

  if (err instanceof PostError && err.reason !== 'internal') {
    return {
      accountId: acct.id,
      message: err.reason
        ? err.reason
        : `Account "${acct.name}" is not linked properly. Please link it again.`,
    };
  }

  return {
    accountId: acct.id,
    message:
      'There was an internal error. Please get in touch https://actualbudget.org/contact for support.',
    internal: err.stack,
  };
}

function getBankSyncStatusFromError(
  err: Error | PostError | BankSyncError,
): BankSyncStatus {
  if (isBankSyncError(err)) {
    if (
      (err.category === 'ITEM_ERROR' && err.code === 'ITEM_LOGIN_REQUIRED') ||
      (err.category === 'INVALID_INPUT' &&
        err.code === 'INVALID_ACCESS_TOKEN') ||
      err.category === 'INVALID_ACCESS_TOKEN'
    ) {
      return 'reauth-required';
    }

    if (err.category === 'ACCOUNT_NEEDS_ATTENTION') {
      return 'attention-required';
    }
  }

  return 'failed';
}

function persistBankSyncError(
  accountId: AccountEntity['id'],
  err: Error | PostError | BankSyncError,
) {
  return db.update('accounts', {
    id: accountId,
    bank_sync_status: getBankSyncStatusFromError(err),
  });
}

export type SyncResponseWithErrors = SyncResponse & {
  errors: SyncError[];
};

async function accountsBankSync({
  ids = [],
}: {
  ids: Array<AccountEntity['id']>;
}): Promise<SyncResponseWithErrors> {
  const { 'user-id': userId, 'user-key': userKey } =
    await asyncStorage.multiGet(['user-id', 'user-key']);

  const accounts = db.runQuery<db.DbAccount & { bankId: db.DbBank['bank_id'] }>(
    `
    SELECT a.*, b.bank_id as bankId
    FROM accounts a
    LEFT JOIN banks b ON a.bank = b.id
    WHERE a.tombstone = 0 AND a.closed = 0
      ${ids.length ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : ''}
    ORDER BY a.offbudget, a.sort_order
  `,
    ids,
    true,
  );

  const errors: ReturnType<typeof handleSyncError>[] = [];
  const newTransactions: Array<TransactionEntity['id']> = [];
  const matchedTransactions: Array<TransactionEntity['id']> = [];
  const updatedAccounts: Array<AccountEntity['id']> = [];

  for (const acct of accounts) {
    if (acct.bankId && acct.account_id) {
      try {
        logger.group('Bank Sync operation for account:', acct.name);
        const syncResponse = await bankSync.syncAccount(
          userId as string,
          userKey as string,
          acct.id,
          acct.account_id,
          acct.bankId,
        );

        const syncResponseData = await handleSyncResponse(
          syncResponse,
          acct.id,
        );

        newTransactions.push(...syncResponseData.newTransactions);
        matchedTransactions.push(...syncResponseData.matchedTransactions);
        updatedAccounts.push(...syncResponseData.updatedAccounts);
      } catch (err) {
        const error = err as Error;
        await persistBankSyncError(acct.id, error);
        errors.push(handleSyncError(error, acct));
        captureException({
          ...error,
          message: 'Failed syncing account "' + acct.name + '."',
        } as Error);
      } finally {
        logger.groupEnd();
      }
    }
  }

  if (updatedAccounts.length > 0) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions', 'accounts'],
    });
  }

  return { errors, newTransactions, matchedTransactions, updatedAccounts };
}

async function simpleFinBatchSync({
  ids = [],
}: {
  ids: Array<AccountEntity['id']>;
}): Promise<
  Array<{ accountId: AccountEntity['id']; res: SyncResponseWithErrors }>
> {
  const accounts = db.runQuery<db.DbAccount & { bankId: db.DbBank['bank_id'] }>(
    `SELECT a.*, b.bank_id as bankId FROM accounts a
         LEFT JOIN banks b ON a.bank = b.id
         WHERE
          a.tombstone = 0
          AND a.closed = 0
          AND a.account_sync_source = 'simpleFin'
          ${ids.length ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : ''}
         ORDER BY a.offbudget, a.sort_order`,
    ids.length ? ids : [],
    true,
  );

  const retVal: Array<{
    accountId: AccountEntity['id'];
    res: {
      errors: ReturnType<typeof handleSyncError>[];
      newTransactions: Array<TransactionEntity['id']>;
      matchedTransactions: Array<TransactionEntity['id']>;
      updatedAccounts: Array<AccountEntity['id']>;
    };
  }> = [];

  logger.group('Bank Sync operation for all SimpleFin accounts');
  try {
    const syncResponses: Array<{
      accountId: AccountEntity['id'];
      res: {
        error_code: string;
        error_type: string;
        added: Array<TransactionEntity['id']>;
        updated: Array<TransactionEntity['id']>;
      };
    }> = await bankSync.simpleFinBatchSync(
      accounts.map(a => ({
        id: a.id,
        account_id: a.account_id || null,
      })),
    );
    for (const syncResponse of syncResponses) {
      const account = accounts.find(a => a.id === syncResponse.accountId);
      if (!account) {
        logger.error(
          `Invalid account ID found in response: ${syncResponse.accountId}. Proceeding to the next account...`,
        );
        continue;
      }

      const errors: ReturnType<typeof handleSyncError>[] = [];
      const newTransactions: Array<TransactionEntity['id']> = [];
      const matchedTransactions: Array<TransactionEntity['id']> = [];
      const updatedAccounts: Array<AccountEntity['id']> = [];

      if (syncResponse.res?.error_code) {
        const bankSyncError = {
          type: 'BankSyncError',
          reason: 'Failed syncing account "' + account.name + '."',
          category: syncResponse.res.error_type,
          code: syncResponse.res.error_code,
        } as BankSyncError;

        await persistBankSyncError(account.id, bankSyncError);
        errors.push(handleSyncError(bankSyncError, account));
      } else if (syncResponse.res) {
        const syncResponseData = await handleSyncResponse(
          syncResponse.res as { added: string[]; updated: string[] },
          account.id,
        );

        newTransactions.push(...syncResponseData.newTransactions);
        matchedTransactions.push(...syncResponseData.matchedTransactions);
        updatedAccounts.push(...syncResponseData.updatedAccounts);
      } else {
        const emptyResponseError = new Error(
          'Failed syncing account "' + account.name + '": empty response',
        );
        await persistBankSyncError(account.id, emptyResponseError);
        errors.push(handleSyncError(emptyResponseError, account));
      }

      retVal.push({
        accountId: syncResponse.accountId,
        res: { errors, newTransactions, matchedTransactions, updatedAccounts },
      });
    }
  } catch (err) {
    for (const account of accounts) {
      const error = err as Error;
      await persistBankSyncError(account.id, error);
      retVal.push({
        accountId: account.id,
        res: {
          errors: [handleSyncError(error, account)],
          newTransactions: [],
          matchedTransactions: [],
          updatedAccounts: [],
        },
      });
    }
  }

  if (retVal.some(a => a.res.updatedAccounts.length > 0)) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions', 'accounts'],
    });
  }

  logger.groupEnd();

  return retVal;
}

async function trueLayerBatchSync({
  ids = [],
}: {
  ids: Array<AccountEntity['id']>;
}): Promise<
  Array<{ accountId: AccountEntity['id']; res: SyncResponseWithErrors }>
> {
  const accounts = db.runQuery<db.DbAccount & { bankId: db.DbBank['bank_id'] }>(
    `SELECT a.*, b.bank_id as bankId FROM accounts a
         LEFT JOIN banks b ON a.bank = b.id
         WHERE
          a.tombstone = 0
          AND a.closed = 0
          AND a.account_sync_source = 'trueLayer'
          ${ids.length ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : ''}
         ORDER BY a.offbudget, a.sort_order`,
    ids.length ? ids : [],
    true,
  );

  const retVal: Array<{
    accountId: AccountEntity['id'];
    res: {
      errors: ReturnType<typeof handleSyncError>[];
      newTransactions: Array<TransactionEntity['id']>;
      matchedTransactions: Array<TransactionEntity['id']>;
      updatedAccounts: Array<AccountEntity['id']>;
    };
  }> = [];

  logger.group('Bank Sync operation for all TrueLayer accounts');
  try {
    const syncResponses: Array<{
      accountId: AccountEntity['id'];
      res: {
        error_code?: string;
        error_type?: string;
        added?: Array<TransactionEntity['id']>;
        updated?: Array<TransactionEntity['id']>;
      };
    }> = await bankSync.trueLayerBatchSync(
      accounts.map(a => ({
        id: a.id,
        account_id: a.account_id || null,
      })),
    );
    for (const syncResponse of syncResponses) {
      const account = accounts.find(a => a.id === syncResponse.accountId);
      if (!account) {
        logger.error(
          `Invalid account ID found in response: ${syncResponse.accountId}. Proceeding to the next account...`,
        );
        continue;
      }

      const errors: ReturnType<typeof handleSyncError>[] = [];
      const newTransactions: Array<TransactionEntity['id']> = [];
      const matchedTransactions: Array<TransactionEntity['id']> = [];
      const updatedAccounts: Array<AccountEntity['id']> = [];

      if (syncResponse.res?.error_code) {
        errors.push(
          handleSyncError(
            {
              type: 'BankSyncError',
              reason: 'Failed syncing account "' + account.name + '."',
              category: syncResponse.res.error_type,
              code: syncResponse.res.error_code,
            } as BankSyncError,
            account,
          ),
        );
      } else if (syncResponse.res) {
        const syncResponseData = await handleSyncResponse(
          syncResponse.res as { added: string[]; updated: string[] },
          account.id,
        );
        newTransactions.push(...syncResponseData.newTransactions);
        matchedTransactions.push(...syncResponseData.matchedTransactions);
        updatedAccounts.push(...syncResponseData.updatedAccounts);
      } else {
        errors.push(
          handleSyncError(
            new Error(
              'Failed syncing account "' + account.name + '": empty response',
            ),
            account,
          ),
        );
      }

      retVal.push({
        accountId: account.id,
        res: { errors, newTransactions, matchedTransactions, updatedAccounts },
      });
    }
  } catch (err) {
    const error = err as Error;
    logger.error('Failed syncing TrueLayer accounts:', error);
    captureException(error);
  } finally {
    logger.groupEnd();
  }

  if (retVal.some(v => v.res.updatedAccounts.length > 0)) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
    });
  }

  return retVal;
}

export type ImportTransactionsResult = bankSync.ReconcileTransactionsResult & {
  errors: Array<{
    message: string;
  }>;
};

async function importTransactions({
  accountId,
  transactions,
  isPreview,
  opts,
}: {
  accountId: AccountEntity['id'];
  transactions: ImportTransactionEntity[];
  isPreview: boolean;
  opts?: ImportTransactionsOpts;
}): Promise<ImportTransactionsResult> {
  if (typeof accountId !== 'string') {
    throw APIError('transactions-import: accountId must be an id');
  }

  try {
    const reconciled = await bankSync.reconcileTransactions(
      accountId,
      transactions,
      false,
      true,
      isPreview,
      opts?.defaultCleared,
      false,
      opts?.reimportDeleted,
    );
    return {
      errors: [],
      added: reconciled.added,
      updated: reconciled.updated,
      updatedPreview: reconciled.updatedPreview,
    };
  } catch (err) {
    if (err instanceof TransactionError) {
      return {
        errors: [{ message: err.message }],
        added: [],
        updated: [],
        updatedPreview: [],
      };
    }

    throw err;
  }
}

async function unlinkAccount({ id }: { id: AccountEntity['id'] }) {
  const accRow = await db.first<db.DbAccount>(
    'SELECT * FROM accounts WHERE id = ?',
    [id],
  );

  if (!accRow) {
    throw new Error(`Account with ID ${id} not found.`);
  }

  const bankId = accRow.bank;

  if (!bankId) {
    return 'ok';
  }

  const isGoCardless = accRow.account_sync_source === 'goCardless';

  await db.updateAccount({
    id,
    account_id: null,
    bank: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    bank_sync_status: null,
  });

  if (isGoCardless === false) {
    return;
  }

  const accountWithBankResult = await db.first<{ count: number }>(
    'SELECT COUNT(*) as count FROM accounts WHERE bank = ?',
    [bankId],
  );

  // No more accounts are associated with this bank. We can remove
  // it from GoCardless.
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return 'ok';
  }

  if (!accountWithBankResult || accountWithBankResult.count === 0) {
    const bank = await db.first<Pick<db.DbBank, 'bank_id'>>(
      'SELECT bank_id FROM banks WHERE id = ?',
      [bankId],
    );

    if (!bank) {
      throw new Error(`Bank with ID ${bankId} not found.`);
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('Failed to get server config.');
    }

    const requisitionId = bank.bank_id;

    try {
      await post(
        serverConfig.GOCARDLESS_SERVER + '/remove-account',
        {
          requisitionId,
        },
        {
          'X-ACTUAL-TOKEN': userToken,
        },
      );
    } catch (error) {
      logger.log({ error });
    }
  }

  return 'ok';
}

async function linkTrueLayerAccount({
  account,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  account: SyncServerTrueLayerAccount;
}) {
  let id;
  const institution =
    typeof account.institution === 'string'
      ? { name: account.institution, id: 'legacy' }
      : {
          name: account.institution.name,
          id: account.institution.id || 'legacy',
        };

  const bank = await link.findOrCreateBank(
    { name: institution.name },
    institution.id, // connectionId is used as bank_id
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: account.account_id,
      bank: bank.id,
      account_sync_source: 'trueLayer',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: account.account_id,
      mask: account.mask,
      name: account.name,
      official_name: account.official_name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'trueLayer',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  const syncRes = await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    account.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  await handleSyncResponse(syncRes, id);

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions'],
  });

  return 'ok';
}

async function trueLayerStatus() {
  const clientId = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-id'",
  );
  const clientSecret = await db.first<{ value: string }>(
    "SELECT value FROM preferences WHERE id = 'truelayer-client-secret'",
  );
  return clientId?.value && clientSecret?.value ? 'connected' : 'not-connected';
}

async function trueLayerAuthStatus() {
  const connections = await truelayer.getConnections();
  return connections.length > 0 ? 'authenticated' : 'not-authenticated';
}

async function trueLayerAccounts() {
  try {
    const connections = await truelayer.getConnections();
    const allAccounts = [];

    const existingAccounts = await db.getAccounts();
    const linkedTrueLayerAccountIds = new Set(
      existingAccounts
        .filter(a => (a.account_sync_source as string) === 'trueLayer')
        .map(a => a.account_id),
    );

    for (const connectionId of connections) {
      try {
        const [accounts, cards] = await Promise.all([
          truelayer.listAccounts(connectionId).catch(err => {
            logger.warn(
              `Could not fetch accounts for connection ${connectionId}:`,
              err,
            );
            return [];
          }),
          truelayer.listCards(connectionId).catch(err => {
            logger.warn(
              `Could not fetch cards for connection ${connectionId}:`,
              err,
            );
            return [];
          }),
        ]);

        const mappedAccounts = accounts
          .filter(
            a => !linkedTrueLayerAccountIds.has(`account:${a.account_id}`),
          )
          .map(a => ({
            account_id: `account:${a.account_id}`,
            name: a.display_name,
            official_name: a.display_name,
            mask: a.account_number.number || '',
            institution: {
              id: connectionId,
              name: a.provider.provider_id,
            },
          }));

        const mappedCards = cards
          .filter(c => !linkedTrueLayerAccountIds.has(`card:${c.account_id}`))
          .map(c => ({
            account_id: `card:${c.account_id}`,
            name: c.display_name,
            official_name: c.display_name,
            mask: c.partial_card_number,
            institution: {
              id: connectionId,
              name: c.provider.provider_id,
            },
          }));

        allAccounts.push(...mappedAccounts, ...mappedCards);
      } catch (err) {
        logger.error(
          `Unexpected error processing connection ${connectionId}:`,
          err,
        );
      }
    }

    return allAccounts;
  } catch (err) {
    if (err instanceof Error && err.message === 'No access token') {
      return { error: { message: 'No access token', code: 'no-token' } };
    }
    throw err;
  }
}

async function trueLayerDisconnect({ connectionId }: { connectionId: string }) {
  if (connectionId === 'all') {
    const connections = await truelayer.getConnections();
    for (const id of connections) {
      await truelayer.removeConnection(id);
    }
    // Also remove legacy tokens
    await truelayer.removeConnection('legacy');
    return 'ok';
  }

  await truelayer.removeConnection(connectionId);
  return 'ok';
}

async function trueLayerGetConnections() {
  const connections = await truelayer.getConnections();
  const results = [];

  for (const id of connections) {
    try {
      const suffix = truelayer.getPrefSuffix(id);
      // We can try to fetch me info to get provider name, or just return IDs
      // For now, let's try to get me info
      const me = await truelayer.getMe(id).catch(() => null);
      results.push({
        id,
        providerId: me?.provider?.provider_id || 'Unknown',
        fullName: me?.provider?.display_name || 'Legacy',
      });
    } catch (e) {
      results.push({ id, providerId: 'Error', fullName: 'Error' });
    }
  }

  return results;
}

export const app = createApp<AccountHandlers>();

app.method('account-update', mutator(undoable(updateAccount)));
app.method('accounts-get', getAccounts);
app.method('account-balance', getAccountBalance);
app.method('account-properties', getAccountProperties);
app.method('gocardless-accounts-link', linkGoCardlessAccount);
app.method('simplefin-accounts-link', linkSimpleFinAccount);
app.method('pluggyai-accounts-link', linkPluggyAiAccount);
app.method('akahu-accounts-link', linkAkahuAccount);
app.method('enablebanking-accounts-link', linkEnableBankingAccount);
app.method('account-create', mutator(undoable(createAccount)));
app.method('account-close', mutator(closeAccount));
app.method('account-reopen', mutator(undoable(reopenAccount)));
app.method('account-move', mutator(undoable(moveAccount)));
app.method('secret-set', setSecret);
app.method('secret-check', checkSecret);
app.method('gocardless-poll-web-token', pollGoCardlessWebToken);
app.method('gocardless-poll-web-token-stop', stopGoCardlessWebTokenPolling);
app.method('gocardless-status', goCardlessStatus);
app.method('simplefin-status', simpleFinStatus);
app.method('pluggyai-status', pluggyAiStatus);
app.method('akahu-status', akahuStatus);
app.method('enablebanking-status', enableBankingStatus);
app.method('enablebanking-aspsps', enableBankingAspsps);
app.method('enablebanking-start-auth', enableBankingStartAuth);
app.method('enablebanking-complete-auth', enableBankingCompleteAuth);
app.method('enablebanking-poll-auth', enableBankingPollAuth);
app.method('enablebanking-poll-auth-stop', stopEnableBankingPollAuth);
app.method('enablebanking-configure', enableBankingConfigure);
app.method('simplefin-accounts', simpleFinAccounts);
app.method('pluggyai-accounts', pluggyAiAccounts);
app.method('akahu-accounts', akahuAccounts);
app.method('gocardless-get-banks', getGoCardlessBanks);
app.method('gocardless-create-web-token', createGoCardlessWebToken);
app.method('accounts-bank-sync', accountsBankSync);
app.method('simplefin-batch-sync', simpleFinBatchSync);
app.method('transactions-import', mutator(undoable(importTransactions)));
app.method('account-unlink', mutator(unlinkAccount));
app.method('truelayer-complete-auth', trueLayerCompleteAuth);
app.method('truelayer-status', trueLayerStatus);
app.method('truelayer-auth-status', trueLayerAuthStatus);
app.method('truelayer-accounts', trueLayerAccounts);
app.method('truelayer-accounts-link', linkTrueLayerAccount);
app.method('truelayer-batch-sync', trueLayerBatchSync);
app.method('truelayer-disconnect', trueLayerDisconnect);
app.method('truelayer-get-connections', trueLayerGetConnections);
