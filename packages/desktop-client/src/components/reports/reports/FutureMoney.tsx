import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { AlignedText } from '@actual-app/components/aligned-text';
import { Block } from '@actual-app/components/block';
import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgCalendar, SvgChart } from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { Menu } from '@actual-app/components/menu';
import { Paragraph } from '@actual-app/components/paragraph';
import { Popover } from '@actual-app/components/popover';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  FutureMoneyWidget,
  RuleConditionEntity,
  TimeFrame,
} from '@actual-app/core/types/models';

import { EditablePageHeaderTitle } from '#components/EditablePageHeaderTitle';
import { FinancialText } from '#components/FinancialText';
import { Checkbox } from '#components/forms';
import { MobileBackButton } from '#components/mobile/MobileBackButton';
import { MobilePageHeader, Page, PageHeader } from '#components/Page';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { Change } from '#components/reports/Change';
import { FutureMoneyGraph } from '#components/reports/graphs/FutureMoneyGraph';
import { Header } from '#components/reports/Header';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { calculateTimeRange } from '#components/reports/reportRanges';
import { createFutureMoneySpreadsheet } from '#components/reports/spreadsheets/future-money-spreadsheet';
import type { FutureMoneyData } from '#components/reports/spreadsheets/future-money-spreadsheet';
import { useReport } from '#components/reports/useReport';
import { useAccounts } from '#hooks/useAccounts';
import { useDashboardWidget } from '#hooks/useDashboardWidget';
import { useFormat } from '#hooks/useFormat';
import { useNavigate } from '#hooks/useNavigate';
import { useRuleConditionFilters } from '#hooks/useRuleConditionFilters';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';
import { useUpdateDashboardWidgetMutation } from '#reports/mutations';

export function FutureMoney() {
  const params = useParams();
  const { data: widget, isPending } = useDashboardWidget<FutureMoneyWidget>({
    id: params.id,
    type: 'future-money-card',
  });

  if (isPending) {
    return <LoadingIndicator />;
  }

  return <FutureMoneyInner widget={widget} />;
}

type FutureMoneyInnerProps = {
  widget?: FutureMoneyWidget;
};

function FutureMoneyInner({ widget }: FutureMoneyInnerProps) {
  const dispatch = useDispatch();
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const { isNarrowWidth } = useResponsive();
  const { data: accounts = [] } = useAccounts();
  const [_firstDayOfWeekIdx] = useSyncedPref('firstDayOfWeekIdx');
  const firstDayOfWeekIdx = _firstDayOfWeekIdx || '0';

  const {
    conditions,
    conditionsOp,
    onApply: onApplyFilter,
    onDelete: onDeleteFilter,
    onUpdate: onUpdateFilter,
    onConditionsOpChange,
  } = useRuleConditionFilters<RuleConditionEntity>(
    widget?.meta?.conditions,
    widget?.meta?.conditionsOp,
  );

  const [projectionMonths, setProjectionMonths] = useState(
    widget?.meta?.projectionMonths ?? 6,
  );
  const [averagingPeriod, setAveragingPeriod] = useState(
    widget?.meta?.averagingPeriod ?? 6,
  );
  const [useManualIncome, setUseManualIncome] = useState(
    widget?.meta?.useManualIncome ?? false,
  );
  const [manualIncomeOverrides, setManualIncomeOverrides] = useState(
    widget?.meta?.manualIncomeOverrides ?? {},
  );

  const [start, setStart] = useState(monthUtils.currentMonth());
  const [end, setEnd] = useState(monthUtils.currentMonth());
  const [mode, setMode] = useState<TimeFrame['mode']>('sliding-window');
  const [excludePartialMonths, setExcludePartialMonths] = useState(
    widget?.meta?.excludePartialMonths ??
      (window.localStorage.getItem('future-money-exclude-partial') === 'true' ||
      window.localStorage.getItem('future-money-exclude-partial') === null),
  );

  const handleExcludePartialMonthsToggle = () => {
    setExcludePartialMonths(prev => {
      const newValue = !prev;
      if (!widget) {
        window.localStorage.setItem('future-money-exclude-partial', String(newValue));
      }
      return newValue;
    });
  };

  const [allMonths, setAllMonths] = useState<Array<{
    name: string;
    pretty: string;
  }> | null>(null);

  const [latestTransaction, setLatestTransaction] = useState('');

  useEffect(() => {
    async function run() {
      const earliestTransaction = await send('get-earliest-transaction');
      const latestTransaction = await send('get-latest-transaction');
      const latestDate = latestTransaction
        ? latestTransaction.date
        : monthUtils.currentDay();
      setLatestTransaction(latestDate);

      const currentMonth = monthUtils.currentMonth();
      let earliestMonth = earliestTransaction
        ? monthUtils.monthFromDate(earliestTransaction.date)
        : currentMonth;
      const latestMonth = monthUtils.monthFromDate(latestDate);

      const yearAgo = monthUtils.subMonths(latestMonth, 12);
      if (earliestMonth > yearAgo) {
        earliestMonth = yearAgo;
      }

      const allMonths = monthUtils
        .rangeInclusive(earliestMonth, latestMonth)
        .map(month => ({
          name: month,
          pretty: monthUtils.format(month, 'MMMM yyyy'),
        }))
        .reverse();

      setAllMonths(allMonths);
    }
    void run();
  }, []);

  useEffect(() => {
    if (latestTransaction) {
      const [initialStart, initialEnd, initialMode] = calculateTimeRange(
        widget?.meta?.timeFrame,
        {
          start: monthUtils.subMonths(
            monthUtils.monthFromDate(latestTransaction),
            5,
          ),
          end: monthUtils.monthFromDate(latestTransaction),
          mode: 'sliding-window',
        },
        latestTransaction,
      );
      setStart(initialStart);
      setEnd(initialEnd);
      setMode(initialMode);

      const months =
        monthUtils.differenceInCalendarMonths(initialEnd, initialStart) + 1;
      setAveragingPeriod(months);
    }
  }, [latestTransaction, widget?.meta?.timeFrame]);

  function onChangeDates(start: string, end: string, mode: TimeFrame['mode']) {
    setStart(start);
    setEnd(end);
    setMode(mode);
    const months = monthUtils.differenceInCalendarMonths(end, start) + 1;
    setAveragingPeriod(months);
  }
const params = useMemo(
  () =>
    createFutureMoneySpreadsheet({
      startDate: start,
      endDate: end,
      projectionMonths,
      accountIds: widget?.meta?.accountIds,
      conditions,
      conditionsOp,
      excludePartialMonths,
      useManualIncome,
      manualIncomeOverrides,
    }),
  [
    start,
    end,
    projectionMonths,
    widget?.meta?.accountIds,
    conditions,
    conditionsOp,
    excludePartialMonths,
    useManualIncome,
    manualIncomeOverrides,
  ],
);
  const data = useReport<FutureMoneyData>('future_money', params);

  const updateDashboardWidgetMutation = useUpdateDashboardWidgetMutation();

  const onSaveWidget = async () => {
    if (!widget) return;

    updateDashboardWidgetMutation.mutate(
      {
        widget: {
          id: widget.id,
          meta: {
            ...(widget.meta ?? {}),
            projectionMonths,
            averagingPeriod,
            conditions,
            conditionsOp,
            timeFrame: {
              start,
              end,
              mode,
            },
            excludePartialMonths,
            useManualIncome,
            manualIncomeOverrides,
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

  const title = widget?.meta?.name || t('Future Money');
  const onSaveWidgetName = async (newName: string) => {
    if (!widget) return;
    updateDashboardWidgetMutation.mutate({
      widget: {
        id: widget.id,
        meta: {
          ...(widget.meta ?? {}),
          name: newName || t('Future Money'),
        },
      },
    });
  };

  if (!allMonths || !data) {
    return <LoadingIndicator />;
  }

  const futureBalance = data.graphData[data.graphData.length - 1]?.y ?? 0;
  const totalChange = futureBalance - data.currentBalance;

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
              widget ? (
                <EditablePageHeaderTitle
                  title={title}
                  onSave={onSaveWidgetName}
                />
              ) : (
                title
              )
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
        earliestTransaction={allMonths[allMonths.length - 1].name}
        latestTransaction={latestTransaction}
        firstDayOfWeekIdx={firstDayOfWeekIdx}
        mode={mode}
        onChangeDates={onChangeDates}
        filters={conditions}
        onApply={onApplyFilter}
        onUpdateFilter={onUpdateFilter}
        onDeleteFilter={onDeleteFilter}
        conditionsOp={conditionsOp}
        onConditionsOpChange={onConditionsOpChange}
        inlineContent={
          <>
            <AveragingSelector
              averagingPeriod={averagingPeriod}
              onChange={val => {
                setAveragingPeriod(val);
                const newStart = monthUtils.subMonths(end, val - 1);
                setStart(newStart);
                setMode('static');
              }}
            />
            <ProjectionSelector
              projectionMonths={projectionMonths}
              onChange={setProjectionMonths}
            />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginLeft: 10,
              }}
            >
              <Checkbox
                id="manual-income-field"
                checked={useManualIncome}
                onChange={() => setUseManualIncome(!useManualIncome)}
              />
              <label
                htmlFor="manual-income-field"
                style={{ marginLeft: 4, userSelect: 'none' }}
              >
                <Trans>Manual income</Trans>
              </label>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginLeft: 10,
              }}
            >
              <Checkbox
                id="exclude-partial-months-field"
                checked={excludePartialMonths}
                onChange={handleExcludePartialMonthsToggle}
              />
              <label
                htmlFor="exclude-partial-months-field"
                style={{ marginLeft: 4, userSelect: 'none' }}
              >
                <Trans>Exclude partial months</Trans>
              </label>
            </View>
          </>
        }
      >
        {widget && (
          <Button variant="primary" onPress={onSaveWidget}>
            <Trans>Save widget</Trans>
          </Button>
        )}
      </Header>

      <View
        style={{
          backgroundColor: theme.tableBackground,
          padding: 20,
          paddingTop: 0,
          flex: '1 0 auto',
          overflowY: 'auto',
        }}
      >
        <View
          style={{
            textAlign: 'right',
            paddingTop: 20,
          }}
        >
          <View
            style={{ ...styles.largeText, fontWeight: 400, marginBottom: 5 }}
          >
            <PrivacyFilter>
              <FinancialText>
                {format(futureBalance, 'financial')}
              </FinancialText>
            </PrivacyFilter>
          </View>
          <PrivacyFilter>
            <Change amount={totalChange} />
          </PrivacyFilter>
        </View>

        <FutureMoneyGraph
          graphData={data.graphData}
          showTooltip={!isNarrowWidth}
          style={{ height: 400 }}
        />

        <View style={{ marginTop: 30, userSelect: 'none' }}>
          <Paragraph>
            <strong>
              <Trans>How is future money calculated?</Trans>
            </strong>
          </Paragraph>
          <Paragraph>
            <Trans>
              Future money projects your balance into the future based on your
              average monthly income and expenses. It takes your current
              on-budget balance and adds the average monthly change for each
              month in the projection period.
            </Trans>
          </Paragraph>
          <Paragraph>
            <Trans>
              You can adjust the averaging period to look further back in time,
              and use filters to exclude one-off transactions that might skew
              the projection.
            </Trans>
          </Paragraph>

          <View style={{ marginTop: 20, gap: 10 }}>
            <AlignedText
              left={<Trans>Current Balance:</Trans>}
              right={format(data.currentBalance, 'financial')}
            />
            <AlignedText
              left={<Trans>Monthly Average Income:</Trans>}
              right={format(data.monthlyAverageIncome, 'financial')}
            />
            <AlignedText
              left={<Trans>Monthly Average Expenses:</Trans>}
              right={format(data.monthlyAverageExpenses, 'financial')}
            />
            <AlignedText
              left={<Trans>Monthly Average Change:</Trans>}
              right={format(data.monthlyAverageChange, 'financial')}
              style={{ fontWeight: 'bold' }}
            />
          </View>

          {data.monthlyDetails && data.monthlyDetails.length > 0 && (
            <View style={{ marginTop: 40 }}>
              <Paragraph>
                <strong>
                  <Trans>History Breakdown</Trans>
                </strong>
              </Paragraph>
              <View
                style={{
                  borderTop: `1px solid ${theme.tableBorder}`,
                  marginTop: 10,
                }}
              >
                {data.monthlyDetails.map(detail => (
                  <View
                    key={detail.month}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      padding: '10px 0',
                      borderBottom: `1px solid ${theme.tableBorder}`,
                    }}
                  >
                    <View style={{ flex: 1, fontWeight: 'bold' }}>
                      {monthUtils.format(detail.month, 'MMMM yyyy')}
                      {!detail.isCompleted && (
                        <View
                          style={{
                            ...styles.verySmallText,
                            color: theme.pageTextSubdued,
                            fontWeight: 'normal',
                          }}
                        >
                          <Trans>(Partial month - excluded from average)</Trans>
                        </View>
                      )}
                    </View>
                    <View style={{ flex: 1, textAlign: 'right' }}>
                      <View style={{ color: theme.noticeText }}>
                        Income: {format(detail.income, 'financial')}
                      </View>
                      <View style={{ color: theme.errorText }}>
                        Expenses: {format(detail.expenses, 'financial')}
                      </View>
                      <View style={{ fontWeight: 'bold', marginTop: 5 }}>
                        Change: {format(detail.change, 'financial')}
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={{ marginTop: 40 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Paragraph style={{ margin: 0 }}>
                <strong>
                  <Trans>Projection Breakdown</Trans>
                </strong>
              </Paragraph>
              {useManualIncome &&
                Object.keys(manualIncomeOverrides).length > 0 && (
                  <Button
                    variant="bare"
                    onPress={() => setManualIncomeOverrides({})}
                    style={{ color: theme.errorText }}
                  >
                    <Trans>Reset all overrides</Trans>
                  </Button>
                )}
            </View>
            <View
              style={{
                borderTop: `1px solid ${theme.tableBorder}`,
                marginTop: 10,
              }}
            >
              {data.graphData
                .filter(d => d.isProjection)
                .map((d, i) => {
                  const projectionIdx = i + 1;
                  const isOverridden =
                    useManualIncome &&
                    manualIncomeOverrides[projectionIdx] != null;
                  return (
                    <View
                      key={d.x}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0',
                        borderBottom: `1px solid ${theme.tableBorder}`,
                      }}
                    >
                      <View style={{ flex: 1, fontWeight: 'bold' }}>
                        {monthUtils.format(
                          monthUtils.monthFromDate(d.date),
                          'MMMM yyyy',
                        )}
                      </View>
                      <View style={{ flex: 1, textAlign: 'right' }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            justifyContent: 'flex-end',
                            alignItems: 'center',
                            color: theme.noticeText,
                          }}
                        >
                          <span style={{ marginRight: 5 }}>Income:</span>
                          {useManualIncome ? (
                            <ManualIncomeInput
                              value={d.income || 0}
                              isOverridden={isOverridden}
                              onUpdate={amount => {
                                if (amount === null) {
                                  setManualIncomeOverrides(prev => {
                                    const next = { ...prev };
                                    delete next[projectionIdx];
                                    return next;
                                  });
                                } else {
                                  setManualIncomeOverrides(prev => ({
                                    ...prev,
                                    [projectionIdx]: amount,
                                  }));
                                }
                              }}
                            />
                          ) : (
                            format(d.income || 0, 'financial')
                          )}
                        </View>
                        <View style={{ color: theme.errorText, marginTop: 5 }}>
                          Expenses: {format(d.expenses || 0, 'financial')}
                        </View>
                        <View style={{ fontWeight: 'bold', marginTop: 5 }}>
                          Change: {format(d.change || 0, 'financial')}
                        </View>
                      </View>
                    </View>
                  );
                })}
            </View>
          </View>
        </View>
      </View>
    </Page>
  );
}

function ManualIncomeInput({
  value,
  onUpdate,
  isOverridden,
}: {
  value: number;
  onUpdate: (val: number | null) => void;
  isOverridden: boolean;
}) {
  const [localValue, setLocalValue] = useState(
    (value / 100).toFixed(2).replace(/\.00$/, ''),
  );

  useEffect(() => {
    setLocalValue((value / 100).toFixed(2).replace(/\.00$/, ''));
  }, [value]);

  return (
    <Input
      value={localValue}
      style={{
        width: 100,
        textAlign: 'right',
        fontWeight: isOverridden ? 'bold' : 'normal',
        color: isOverridden ? theme.noticeTextLight : theme.noticeText,
      }}
      onChangeValue={setLocalValue}
      onBlur={() => {
        if (localValue.trim() === '') {
          onUpdate(null);
          return;
        }
        const amount = Math.round(parseFloat(localValue) * 100);
        if (!isNaN(amount)) {
          onUpdate(amount);
        }
      }}
    />
  );
}

function AveragingSelector({
  averagingPeriod,
  onChange,
}: {
  averagingPeriod: number;
  onChange: (val: number) => void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const options = [
    { key: 3, description: t('Last 3 months') },
    { key: 6, description: t('Last 6 months') },
    { key: 12, description: t('Last 1 year') },
    { key: 24, description: t('Last 2 years') },
  ];

  const currentLabel =
    options.find(opt => opt.key === averagingPeriod)?.description ??
    t('{{months}} months average', { months: averagingPeriod });

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        onPress={() => setIsOpen(true)}
        aria-label={t('Change averaging period')}
      >
        <SvgChart style={{ width: 12, height: 12 }} />
        <span style={{ marginLeft: 5 }}>{currentLabel}</span>
      </Button>

      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={isOpen}
        onOpenChange={() => setIsOpen(false)}
      >
        <Menu
          onMenuSelect={item => {
            onChange(Number(item));
            setIsOpen(false);
          }}
          items={options.map(({ key, description }) => ({
            name: String(key),
            text: description,
          }))}
        />
      </Popover>
    </>
  );
}

function ProjectionSelector({
  projectionMonths,
  onChange,
}: {
  projectionMonths: number;
  onChange: (val: number) => void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const options = [
    { key: 1, description: t('Project 1 month') },
    { key: 3, description: t('Project 3 months') },
    { key: 6, description: t('Project 6 months') },
    { key: 12, description: t('Project 1 year') },
    { key: 24, description: t('Project 2 years') },
  ];

  const currentLabel =
    options.find(opt => opt.key === projectionMonths)?.description ??
    t('Project {{months}} months', { months: projectionMonths });

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        onPress={() => setIsOpen(true)}
        aria-label={t('Change projection period')}
      >
        <SvgCalendar style={{ width: 12, height: 12 }} />
        <span style={{ marginLeft: 5 }}>{currentLabel}</span>
      </Button>

      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={isOpen}
        onOpenChange={() => setIsOpen(false)}
      >
        <Menu
          onMenuSelect={item => {
            onChange(Number(item));
            setIsOpen(false);
          }}
          items={options.map(({ key, description }) => ({
            name: String(key),
            text: description,
          }))}
        />
      </Popover>
    </>
  );
}
