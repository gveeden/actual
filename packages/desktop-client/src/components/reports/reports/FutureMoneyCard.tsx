import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  FutureMoneyWidget,
  TimeFrame,
} from '@actual-app/core/types/models';

import { PrivacyFilter } from '#components/PrivacyFilter';
import { FutureMoneyGraph } from '#components/reports/graphs/FutureMoneyGraph';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { ReportCard } from '#components/reports/ReportCard';
import { ReportCardName } from '#components/reports/ReportCardName';
import { calculateTimeRange } from '#components/reports/reportRanges';
import { createFutureMoneySpreadsheet } from '#components/reports/spreadsheets/future-money-spreadsheet';
import type { FutureMoneyData } from '#components/reports/spreadsheets/future-money-spreadsheet';
import { useDashboardWidgetCopyMenu } from '#components/reports/useDashboardWidgetCopyMenu';
import { useReport } from '#components/reports/useReport';
import { useFormat } from '#hooks/useFormat';

type FutureMoneyCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: FutureMoneyWidget['meta'];
  onMetaChange: (newMeta: FutureMoneyWidget['meta']) => void;
  onRemove: () => void;
  onCopy: (targetDashboardId: string) => void;
};

export function FutureMoneyCard({
  widgetId,
  isEditing,
  meta = {},
  onMetaChange,
  onRemove,
  onCopy,
}: FutureMoneyCardProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const [nameMenuOpen, setNameMenuOpen] = useState(false);

  const { menuItems: copyMenuItems, handleMenuSelect: handleCopyMenuSelect } =
    useDashboardWidgetCopyMenu(onCopy);

  const [latestTransaction, setLatestTransaction] = useState<string>('');
  useEffect(() => {
    async function fetchLatestTransaction() {
      const latestTrans = await send('get-latest-transaction');
      setLatestTransaction(
        latestTrans ? latestTrans.date : monthUtils.currentDay(),
      );
    }
    void fetchLatestTransaction();
  }, []);

  const [start, end] = calculateTimeRange(
    meta?.timeFrame,
    {
      start: monthUtils.subMonths(
        monthUtils.monthFromDate(latestTransaction || monthUtils.currentDay()),
        5,
      ),
      end: monthUtils.monthFromDate(
        latestTransaction || monthUtils.currentDay(),
      ),
      mode: 'sliding-window',
    },
    latestTransaction,
  );

  const projectionMonths = meta?.projectionMonths ?? 6;
  const averagingPeriod = monthUtils.differenceInCalendarMonths(end, start) + 1;
  const accountIds = meta?.accountIds ?? [];
  const conditions = meta?.conditions ?? [];
  const conditionsOp = meta?.conditionsOp ?? 'and';

  const params = useMemo(
    () =>
      createFutureMoneySpreadsheet({
        startDate: start,
        endDate: end,
        projectionMonths,
        accountIds,
        conditions,
        conditionsOp,
        excludePartialMonths: meta?.excludePartialMonths ?? true,
        useManualIncome: meta?.useManualIncome,
        manualIncomeOverrides: meta?.manualIncomeOverrides,
      }),
    [
      start,
      end,
      projectionMonths,
      accountIds,
      conditions,
      conditionsOp,
      meta?.excludePartialMonths,
      meta?.useManualIncome,
      meta?.manualIncomeOverrides,
    ],
  );

  const data = useReport<FutureMoneyData>('future_money', params);

  const [isCardHovered, setIsCardHovered] = useState(false);
  const onCardHover = useCallback(() => setIsCardHovered(true), []);
  const onCardHoverEnd = useCallback(() => setIsCardHovered(false), []);

  const futureBalance = data?.graphData[data.graphData.length - 1]?.y ?? 0;

  return (
    <ReportCard
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/future-money/${widgetId}`}
      menuItems={[
        { name: 'rename', text: t('Rename') },
        {
          name: 'toggle-partial-months',
          text: (meta?.excludePartialMonths ?? true)
            ? t('Include partial months')
            : t('Exclude partial months'),
        },
        { name: 'remove', text: t('Remove') },
        ...copyMenuItems,
      ]}
      onMenuSelect={item => {
        if (handleCopyMenuSelect(item)) return;
        switch (item) {
          case 'rename':
            setNameMenuOpen(true);
            break;
          case 'toggle-partial-months':
            onMetaChange({
              ...meta,
              excludePartialMonths: !(meta?.excludePartialMonths ?? true),
            });
            break;
          case 'remove':
            onRemove();
            break;
default:
            throw new Error(`Unrecognized selection: ${item}`);
        }
      }}
    >
      <View
        style={{ flex: 1 }}
        onPointerEnter={onCardHover}
        onPointerLeave={onCardHoverEnd}
      >
        <View style={{ flexDirection: 'row', padding: 20 }}>
          <View style={{ flex: 1 }}>
            <ReportCardName
              name={meta?.name || t('Future Money')}
              isEditing={nameMenuOpen}
              onChange={newName => {
                onMetaChange({
                  ...meta,
                  name: newName,
                });
                setNameMenuOpen(false);
              }}
              onClose={() => setNameMenuOpen(false)}
            />
            <Block
              style={{
                fontSize: 12,
                color: theme.pageTextSubdued,
                marginTop: 4,
              }}
            >
              {t('Projected over {{months}} months', {
                months: projectionMonths,
              })}
            </Block>
          </View>
          {data && (
            <View style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <Block
                style={{
                  ...styles.mediumText,
                  fontWeight: 500,
                  marginBottom: 5,
                  color:
                    futureBalance >= 0
                      ? theme.reportsNumberPositive
                      : theme.reportsNumberNegative,
                }}
              >
                <PrivacyFilter activationFilters={[!isCardHovered]}>
                  {format(futureBalance, 'financial')}
                </PrivacyFilter>
              </Block>
              <Block
                style={{
                  fontSize: 12,
                  color: theme.pageTextSubdued,
                }}
              >
                <Trans>Est. Future Balance</Trans>
              </Block>
            </View>
          )}
        </View>

        {data ? (
          <FutureMoneyGraph
            graphData={data.graphData}
            compact
            style={{ height: 'auto', flex: 1 }}
          />
        ) : (
          <LoadingIndicator />
        )}
      </View>
    </ReportCard>
  );
}
