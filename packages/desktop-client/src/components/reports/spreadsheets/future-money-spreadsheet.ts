import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import * as d from 'date-fns';
import keyBy from 'lodash/keyBy';

import { runAll } from '#components/reports/util';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';

export type FutureMoneyData = {
  currentBalance: number;
  monthlyAverageIncome: number;
  monthlyAverageExpenses: number;
  monthlyAverageChange: number;
  graphData: Array<{
    x: string;
    y: number;
    isProjection: boolean;
    date: Date;
    income?: number;
    expenses?: number;
    change?: number;
  }>;
  monthlyDetails?: Array<{
    month: string;
    income: number;
    expenses: number;
    change: number;
    isCompleted: boolean;
  }>;
};

export function createFutureMoneySpreadsheet({
  startDate,
  endDate,
  projectionMonths = 6,
  accountIds = [],
  conditions = [],
  conditionsOp = 'and',
  excludePartialMonths = false,
  useManualIncome = false,
  manualIncomeOverrides = {},
}: {
  startDate?: string;
  endDate?: string;
  projectionMonths?: number;
  accountIds?: string[];
  conditions?: RuleConditionEntity[];
  conditionsOp?: 'and' | 'or';
  excludePartialMonths?: boolean;
  useManualIncome?: boolean;
  manualIncomeOverrides?: Record<number, number>;
}) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: FutureMoneyData) => void,
  ) => {
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    const currentMonth = endDate
      ? monthUtils.monthFromDate(endDate)
      : monthUtils.currentMonth();

    const historyStartMonth = startDate
      ? monthUtils.monthFromDate(startDate)
      : monthUtils.subMonths(currentMonth, 5);
    const historyEndMonth = currentMonth;

    const historyStart = monthUtils.firstDayOfMonth(historyStartMonth);
    const historyEnd = monthUtils.lastDayOfMonth(historyEndMonth);

    // Queries
    const balanceFilter = {
      ...(accountIds.length > 0
        ? { account: { $oneof: accountIds } }
        : {}),
    };

    const incomeExpenseFilter = {
      ...(accountIds.length > 0
        ? { account: { $oneof: accountIds } }
        : { 'account.offbudget': false }),
    };

    const currentBalanceQuery = q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .filter({
        ...balanceFilter,
        date: { $lte: historyEnd },
      })
      .calculate({ $sum: '$amount' });

    const startingBalanceQuery = q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .filter({ ...balanceFilter, date: { $lt: historyStart } })
      .calculate({ $sum: '$amount' });

    const historyBalancesQuery = q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .filter({
        ...balanceFilter,
        date: { $gte: historyStart, $lte: historyEnd },
      })
      .groupBy({ $month: '$date' })
      .select([{ date: { $month: '$date' } }, { amount: { $sum: '$amount' } }]);

    const historyMonthlyIncomeQuery = q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .filter({
        ...incomeExpenseFilter,
        'payee.transfer_acct': null,
        date: { $gte: historyStart, $lte: historyEnd },
        amount: { $gt: 0 },
      })
      .groupBy({ $month: '$date' })
      .select([{ date: { $month: '$date' } }, { amount: { $sum: '$amount' } }]);

    const historyMonthlyExpenseQuery = q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .filter({
        ...incomeExpenseFilter,
        'payee.transfer_acct': null,
        date: { $gte: historyStart, $lte: historyEnd },
        amount: { $lt: 0 },
      })
      .groupBy({ $month: '$date' })
      .select([{ date: { $month: '$date' } }, { amount: { $sum: '$amount' } }]);

    return runAll(
      [
        currentBalanceQuery,
        startingBalanceQuery,
        historyBalancesQuery,
        historyMonthlyIncomeQuery,
        historyMonthlyExpenseQuery,
      ],
      data => {
        const currentBalance = data[0] || 0;
        const startingBalance = data[1] || 0;
        const historicalMonthlyChanges = keyBy(data[2], 'date');
        const historicalMonthlyIncome = keyBy(data[3], 'date');
        const historicalMonthlyExpenses = keyBy(data[4], 'date');

        const graphData: FutureMoneyData['graphData'] = [];
        const monthlyDetails: NonNullable<FutureMoneyData['monthlyDetails']> = [];

        let totalIncome = 0;
        let totalExpenses = 0;
        let completedMonthCount = 0;

        // 1. History
        let runningBalance = startingBalance;
        const historyMonths = monthUtils.rangeInclusive(
          historyStartMonth,
          historyEndMonth,
        );

        const todayMonth = monthUtils.currentMonth();

        historyMonths.forEach(month => {
          const inc = historicalMonthlyIncome[month]?.amount || 0;
          const exp = historicalMonthlyExpenses[month]?.amount || 0;
          const isCompleted = month < todayMonth;

          if (isCompleted || !excludePartialMonths) {
            totalIncome += inc;
            totalExpenses += exp;
            completedMonthCount++;
          }

          monthlyDetails.push({
            month,
            income: inc,
            expenses: exp,
            change: inc + exp,
            isCompleted: isCompleted || !excludePartialMonths,
          });

          if (historicalMonthlyChanges[month]) {
            runningBalance += historicalMonthlyChanges[month].amount;
          }
          const date = d.parseISO(month + '-01');
          graphData.push({
            x: d.format(date, "MMM ''yy"),
            y: Math.round(runningBalance),
            isProjection: false,
            date,
            income: inc,
            expenses: exp,
            change: inc + exp,
          });
        });

        const safeMonths = Math.max(1, completedMonthCount);
        const monthlyAverageIncome = Math.round(totalIncome / safeMonths);
        const monthlyAverageExpenses = Math.round(totalExpenses / safeMonths);
        const monthlyAverageChange =
          monthlyAverageIncome + monthlyAverageExpenses;

        // 3. Projection
        let projectedBalance = currentBalance;
        const currentMonthDate = d.parseISO(currentMonth + '-01');
        for (let i = 1; i <= projectionMonths; i++) {
          const manualIncome = manualIncomeOverrides[i];
          const monthlyIncome =
            useManualIncome && manualIncome != null
              ? manualIncome
              : monthlyAverageIncome;
          const monthlyChange = monthlyIncome + monthlyAverageExpenses;

          projectedBalance += monthlyChange;
          const projectionDate = d.addMonths(currentMonthDate, i);
          graphData.push({
            x: d.format(projectionDate, "MMM ''yy"),
            y: Math.round(projectedBalance),
            isProjection: true,
            date: projectionDate,
            income: monthlyIncome,
            expenses: monthlyAverageExpenses,
            change: monthlyChange,
          });
        }

        setData({
          currentBalance,
          monthlyAverageIncome,
          monthlyAverageExpenses,
          monthlyAverageChange,
          graphData,
          monthlyDetails,
        });
      },
    );
  };
}
