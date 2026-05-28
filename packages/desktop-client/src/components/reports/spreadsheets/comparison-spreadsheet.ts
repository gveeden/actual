import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import * as d from 'date-fns';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

export function comparisonSpreadsheet(
  startMonth: string,
  endMonth: string,
  metric: 'net_worth' | 'spending' = 'net_worth',
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: {
      currentValue: number;
      previousValue: number;
      delta: number;
      effectiveStart: string;
      effectiveEnd: string;
      previousStart: string;
      previousEnd: string;
    }) => void,
  ) => {
    let filters: unknown[] = [];
    try {
      const response = await send('make-filters-from-conditions', {
        conditions: conditions.filter(cond => !cond.customName),
      });
      filters = response.filters;
    } catch (error) {
      console.error('Error fetching filters:', error);
    }
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    const today = monthUtils.currentDay();
    const currentMonthStr = monthUtils.currentMonth();

    const activeEndMonth = endMonth || currentMonthStr;
    const activeStartMonth = startMonth || activeEndMonth;

    // Use selected months directly
    let currentEndStr: string;
    let previousEndStr: string;

    if (activeStartMonth === activeEndMonth) {
      // Single month selected: compare that month to the previous month
      currentEndStr =
        activeEndMonth === currentMonthStr
          ? today
          : monthUtils.lastDayOfMonth(activeEndMonth);
      
      const prevMonth = monthUtils.prevMonth(activeEndMonth);
      const dayOfMonth = d.parse(currentEndStr, 'yyyy-MM-dd', new Date()).getDate();
      const prevMonthFirstDay = d.parse(monthUtils.firstDayOfMonth(prevMonth), 'yyyy-MM-dd', new Date());
      const exactPreviousEnd = d.setDate(prevMonthFirstDay, Math.min(dayOfMonth, d.getDaysInMonth(prevMonthFirstDay)));
      previousEndStr = d.format(exactPreviousEnd, 'yyyy-MM-dd');
    } else {
      // Range selected: compare end of range to start of range
      currentEndStr =
        activeEndMonth === currentMonthStr
          ? today
          : monthUtils.lastDayOfMonth(activeEndMonth);
      
      previousEndStr =
        activeStartMonth === currentMonthStr
          ? today
          : monthUtils.lastDayOfMonth(activeStartMonth);
    }

    const currentStartStr = monthUtils.firstDayOfMonth(activeEndMonth);
    const previousStartStr = monthUtils.firstDayOfMonth(activeStartMonth);

    let currentValue = 0;
    let previousValue = 0;

    if (metric === 'net_worth') {
      try {
        const currentData = await aqlQuery(
          q('transactions')
            .filter({
              $and: [{ date: { $lte: currentEndStr } }],
            })
            .filter({
              [conditionsOpKey]: filters,
            })
            .select([{ amount: { $sum: '$amount' } }]),
        );
        currentValue = currentData.data[0]?.amount ?? 0;

        const previousData = await aqlQuery(
          q('transactions')
            .filter({
              $and: [{ date: { $lte: previousEndStr } }],
            })
            .filter({
              [conditionsOpKey]: filters,
            })
            .select([{ amount: { $sum: '$amount' } }]),
        );
        previousValue = previousData.data[0]?.amount ?? 0;
      } catch (error) {
        console.error('Error executing query:', error);
      }
    } else if (metric === 'spending') {
      try {
        const { data: categories } = await aqlQuery(
          q('categories').select(['id', 'is_income']),
        );
        const expenseCategoryIds = categories
          .filter((c: any) => !c.is_income)
          .map((c: any) => c.id);

        const currentData = await aqlQuery(
          q('transactions')
            .filter({
              $and: [
                { date: { $gte: currentStartStr } },
                { date: { $lte: currentEndStr } },
                { category: { $oneof: expenseCategoryIds } },
              ],
            })
            .filter({
              [conditionsOpKey]: filters,
            })
            .select([{ amount: { $sum: '$amount' } }]),
        );
        currentValue = currentData.data[0]?.amount ?? 0;

        const previousData = await aqlQuery(
          q('transactions')
            .filter({
              $and: [
                { date: { $gte: previousStartStr } },
                { date: { $lte: previousEndStr } },
                { category: { $oneof: expenseCategoryIds } },
              ],
            })
            .filter({
              [conditionsOpKey]: filters,
            })
            .select([{ amount: { $sum: '$amount' } }]),
        );
        previousValue = previousData.data[0]?.amount ?? 0;
      } catch (error) {
        console.error('Error executing query:', error);
      }
    }

    setData({
      currentValue,
      previousValue,
      delta: currentValue - previousValue,
      effectiveStart: currentStartStr,
      effectiveEnd: currentEndStr,
      previousStart: previousStartStr,
      previousEnd: previousEndStr,
    });
  };
}