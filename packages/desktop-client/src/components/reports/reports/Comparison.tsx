import React, { useMemo, useState, useEffect, type CSSProperties } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useParams } from 'react-router';

import { Block } from '@actual-app/components/block';
import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgEquals } from '@actual-app/components/icons/v1';
import {
  SvgCloseParenthesis,
  SvgOpenParenthesis,
  SvgSum,
} from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type { ComparisonWidget, TimeFrame } from '@actual-app/core/types/models';
import { parseISO } from 'date-fns';

import { EditablePageHeaderTitle } from '#components/EditablePageHeaderTitle';
import { AppliedFilters } from '#components/filters/AppliedFilters';
import { FilterButton } from '#components/filters/FiltersMenu';
import { MobileBackButton } from '#components/mobile/MobileBackButton';
import { MobilePageHeader, Page, PageHeader } from '#components/Page';
import { Header } from '#components/reports/Header';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { calculateTimeRange } from '#components/reports/reportRanges';
import { comparisonSpreadsheet } from '#components/reports/spreadsheets/comparison-spreadsheet';
import { SummaryNumber } from '#components/reports/SummaryNumber';
import { useReport } from '#components/reports/useReport';
import { fromDateRepr } from '#components/reports/util';
import { useDashboardWidget } from '#hooks/useDashboardWidget';
import { useLocale } from '#hooks/useLocale';
import { useNavigate } from '#hooks/useNavigate';
import { useRuleConditionFilters } from '#hooks/useRuleConditionFilters';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';
import { useUpdateDashboardWidgetMutation } from '#reports/mutations';

export function Comparison() {
  const params = useParams();
  const { data: widget, isPending } = useDashboardWidget<ComparisonWidget>({
    id: params.id,
    type: 'comparison-card',
  });

  if (isPending) {
    return <LoadingIndicator />;
  }

  return <ComparisonInner widget={widget} />;
}

type ComparisonInnerProps = {
  widget?: ComparisonWidget;
};

type FilterObject = ReturnType<typeof useRuleConditionFilters>;

function ComparisonInner({ widget }: ComparisonInnerProps) {
  const locale = useLocale();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { isNarrowWidth } = useResponsive();
  const updateDashboardWidgetMutation = useUpdateDashboardWidgetMutation();

  const [metric, setMetric] = useState<'net_worth' | 'spending'>(
    widget?.meta?.metric || 'net_worth',
  );

  const {
    conditions,
    conditionsOp,
    saved,
    onApply: onApplyFilter,
    onDelete: onDeleteFilter,
    onUpdate: onUpdateFilter,
    onConditionsOpChange,
  } = useRuleConditionFilters(
    widget?.meta?.conditions ?? [],
    widget?.meta?.conditionsOp ?? 'and',
  );

  const [allMonths, setAllMonths] = useState<
    Array<{
      name: string;
      pretty: string;
    }>
  >([]);

  const [earliestTransaction, setEarliestTransaction] = useState('');
  const [latestTransaction, setLatestTransaction] = useState('');
  const [_firstDayOfWeekIdx] = useSyncedPref('firstDayOfWeekIdx');
  const firstDayOfWeekIdx = _firstDayOfWeekIdx || '0';

  useEffect(() => {
    async function run() {
      const earliestTransaction = await send('get-earliest-transaction');
      setEarliestTransaction(
        earliestTransaction
          ? earliestTransaction.date
          : monthUtils.currentDay(),
      );

      const latestTransaction = await send('get-latest-transaction');
      setLatestTransaction(
        latestTransaction ? latestTransaction.date : monthUtils.currentDay(),
      );

      const currentMonth = monthUtils.currentMonth();
      let earliestMonth = earliestTransaction
        ? monthUtils.monthFromDate(
            parseISO(fromDateRepr(earliestTransaction.date)),
          )
        : currentMonth;
      const latestTransactionMonth = latestTransaction
        ? monthUtils.monthFromDate(
            parseISO(fromDateRepr(latestTransaction.date)),
          )
        : currentMonth;

      const latestMonth =
        latestTransactionMonth > currentMonth
          ? latestTransactionMonth
          : currentMonth;

      const yearAgo = monthUtils.subMonths(latestMonth, 12);
      if (earliestMonth > yearAgo) {
        earliestMonth = yearAgo;
      }

      const allMonths = monthUtils
        .rangeInclusive(earliestMonth, latestMonth)
        .map(month => ({
          name: month,
          pretty: monthUtils.format(month, 'MMMM yyyy', locale),
        }))
        .reverse();

      setAllMonths(allMonths);
    }
    void run();
  }, [locale]);

  const [start, setStart] = useState(monthUtils.currentMonth());
  const [end, setEnd] = useState(monthUtils.currentMonth());
  const [mode, setMode] = useState<TimeFrame['mode']>('full');

  useEffect(() => {
    if (latestTransaction) {
      const [initialStart, initialEnd, initialMode] = calculateTimeRange(
        widget?.meta?.timeFrame,
        {
          start: monthUtils.currentMonth(),
          end: monthUtils.currentMonth(),
          mode: 'full',
        },
        latestTransaction,
      );
      setStart(initialStart);
      setEnd(initialEnd);
      setMode(initialMode);
    }
  }, [latestTransaction, widget?.meta?.timeFrame]);

  function onChangeDates(start: string, end: string, mode: TimeFrame['mode']) {
    setStart(start);
    setEnd(end);
    setMode(mode);
  }

  const params = useMemo(
    () => comparisonSpreadsheet(start, end, metric, conditions, conditionsOp),
    [start, end, metric, conditions, conditionsOp],
  );

  const data = useReport('comparison', params);

  const title =
    widget?.meta?.name ||
    (metric === 'spending'
      ? t('Spending Comparison')
      : t('Net Worth Comparison'));

  const onSaveWidget = async () => {
    if (!widget) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            message: t('Cannot save: No widget available.'),
          },
        }),
      );
      return;
    }

    updateDashboardWidgetMutation.mutate(
      {
        widget: {
          id: widget.id,
          meta: {
            ...widget.meta,
            metric,
            conditions,
            conditionsOp,
            timeFrame: {
              start,
              end,
              mode,
            },
          },
        },
      },
      {
        onSuccess: () => {
          dispatch(
            addNotification({
              notification: {
                type: 'message',
                message: t('Dashboard widget successfully saved.'),
              },
            }),
          );
        },
      },
    );
  };

  const onSaveWidgetName = (newName: string) => {
    if (widget) {
      updateDashboardWidgetMutation.mutate({
        widget: {
          id: widget.id,
          meta: {
            ...widget.meta,
            name: newName,
          },
        },
      });
    }
  };

  const filterObject: FilterObject = {
    conditions,
    conditionsOp,
    saved,
    onApply: onApplyFilter,
    onDelete: onDeleteFilter,
    onUpdate: onUpdateFilter,
    onConditionsOpChange,
  };

  return (
    <Page
      header={
        isNarrowWidth ? (
          <MobilePageHeader
            title={title}
            leftContent={
              <MobileBackButton onPress={() => navigate('/reports')} />
            }
          />
        ) : (
          <PageHeader
            title={
              <>
                <MobileBackButton onPress={() => navigate('/reports')} />
                <EditablePageHeaderTitle
                  title={title}
                  onSave={onSaveWidgetName}
                />
              </>
            }
          />
        )
      }
      padding={0}
    >
      <Header
        allMonths={allMonths}
        start={start}
        end={end}
        earliestTransaction={earliestTransaction}
        latestTransaction={latestTransaction}
        firstDayOfWeekIdx={firstDayOfWeekIdx}
        mode={mode}
        onChangeDates={onChangeDates}
        show1Month
        filters={conditions}
        conditionsOp={conditionsOp}
        onApply={onApplyFilter}
        onUpdateFilter={onUpdateFilter}
        onDeleteFilter={onDeleteFilter}
        onConditionsOpChange={onConditionsOpChange}
      >
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Block style={{ fontWeight: 600 }}>Metric:</Block>
          <Button
            variant={metric === 'net_worth' ? 'primary' : 'normal'}
            onPress={() => setMetric('net_worth')}
          >
            <Trans>Net Worth</Trans>
          </Button>
          <Button
            variant={metric === 'spending' ? 'primary' : 'normal'}
            onPress={() => setMetric('spending')}
          >
            <Trans>Spending</Trans>
          </Button>
          {widget && (
            <Button
              variant="primary"
              onPress={onSaveWidget}
              style={{ marginLeft: 15 }}
            >
              <Trans>Save widget</Trans>
            </Button>
          )}
        </View>
      </Header>

      <View
        style={{
          width: '100%',
          background: theme.pageBackground,
          flexGrow: 1,
          padding: 20,
        }}
      >
        <View
          style={{
            flexDirection: isNarrowWidth ? 'column' : 'row',
            justifyContent: 'center',
            width: '100%',
            alignItems: 'center',
            gap: 40,
          }}
        >
          {data ? (
            <>
              {/* Period 1 */}
              <View style={{ alignItems: 'center', gap: 10 }}>
                <SumWithRange
                  from={
                    metric === 'spending'
                      ? monthUtils.format(data.effectiveStart, 'MMM yy', locale)
                      : ''
                  }
                  to={monthUtils.format(data.effectiveEnd, 'MMM d, yy', locale)}
                  filterObject={filterObject}
                />
                <View style={{ width: 250, height: 100 }}>
                  <SummaryNumber
                    value={data.currentValue}
                    contentType="sum"
                    loading={!data}
                  />
                </View>
              </View>

              <View style={{ padding: 20 }}>
                <div
                  style={{
                    width: 40,
                    height: 2,
                    background: theme.pageTextSubdued,
                  }}
                />
              </View>

              {/* Period 2 */}
              <View style={{ alignItems: 'center', gap: 10 }}>
                <SumWithRange
                  from={
                    metric === 'spending'
                      ? monthUtils.format(data.previousStart, 'MMM yy', locale)
                      : ''
                  }
                  to={monthUtils.format(data.previousEnd, 'MMM d, yy', locale)}
                  filterObject={filterObject}
                />
                <View style={{ width: 250, height: 100 }}>
                  <SummaryNumber
                    value={data.previousValue}
                    contentType="sum"
                    loading={!data}
                  />
                </View>
              </View>

              <SvgEquals width={50} height={50} style={{ color: theme.pageTextSubdued }} />

              {/* Delta */}
              <View style={{ alignItems: 'center', gap: 10 }}>
                <Block style={{ color: theme.pageTextSubdued, fontSize: 16, fontWeight: 500 }}>
                  <Trans>Difference</Trans>
                </Block>
                <View style={{ width: 300, height: 120 }}>
                  <SummaryNumber
                    value={data.delta}
                    contentType="sum"
                    loading={!data}
                  />
                </View>
              </View>
            </>
          ) : (
            <LoadingIndicator />
          )}
        </View>
      </View>
    </Page>
  );
}

type SumWithRangeProps = {
  from: string;
  to: string;
  containerStyle?: CSSProperties;
  filterObject: FilterObject;
};

function SumWithRange({
  from,
  to,
  containerStyle,
  filterObject,
}: SumWithRangeProps) {
  const { t } = useTranslation();

  return (
    <View
      style={{
        ...containerStyle,
        height: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '70px 15px 1fr 15px',
      }}
    >
      <View style={{ position: 'relative', height: '50px', marginRight: 50 }}>
        <SvgSum width={50} height={50} />
        <Text
          style={{
            position: 'absolute',
            right: -30,
            top: -20,
            whiteSpace: 'nowrap',
          }}
        >
          {to}
        </Text>
        <Text
          style={{
            position: 'absolute',
            right: -30,
            bottom: -20,
            whiteSpace: 'nowrap',
          }}
        >
          {from}
        </Text>
      </View>
      <SvgOpenParenthesis width={15} style={{ height: '100%' }} />
      <View style={{ marginLeft: 16, maxWidth: '250px', marginRight: 16 }}>
        {(filterObject.conditions?.length ?? 0) === 0 ? (
          <Text style={{ fontSize: '25px', color: theme.pageTextPositive }}>
            {t('all transactions')}
          </Text>
        ) : (
          <AppliedFilters
            conditions={filterObject.conditions}
            onUpdate={filterObject.onUpdate}
            onDelete={filterObject.onDelete}
            conditionsOp={filterObject.conditionsOp}
            onConditionsOpChange={filterObject.onConditionsOpChange}
          />
        )}
      </View>
      <SvgCloseParenthesis width={15} style={{ height: '100%' }} />
      <View style={{ position: 'absolute', top: -15, right: -55 }}>
        <FilterButton
          compact={false}
          onApply={filterObject.onApply}
          hover={false}
        />
      </View>
    </View>
  );
}