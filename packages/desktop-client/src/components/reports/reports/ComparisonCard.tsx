import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type { ComparisonWidget } from '@actual-app/core/types/models';

import { DateRange } from '#components/reports/DateRange';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { ReportCard } from '#components/reports/ReportCard';
import { ReportCardName } from '#components/reports/ReportCardName';
import { calculateTimeRange } from '#components/reports/reportRanges';
import { comparisonSpreadsheet } from '#components/reports/spreadsheets/comparison-spreadsheet';
import { SummaryNumber } from '#components/reports/SummaryNumber';
import { useDashboardWidgetCopyMenu } from '#components/reports/useDashboardWidgetCopyMenu';
import { useReport } from '#components/reports/useReport';

type ComparisonCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: ComparisonWidget['meta'];
  onMetaChange: (newMeta: ComparisonWidget['meta']) => void;
  onRemove: () => void;
  onCopy: (targetDashboardId: string) => void;
};

export function ComparisonCard({
  widgetId,
  isEditing,
  meta,
  onMetaChange,
  onRemove,
  onCopy,
}: ComparisonCardProps) {
  const { t } = useTranslation();

  const [nameMenuOpen, setNameMenuOpen] = useState(false);

  const { menuItems: copyMenuItems, handleMenuSelect: handleCopyMenuSelect } =
    useDashboardWidgetCopyMenu(onCopy);

  const [start, setStart] = useState(monthUtils.currentMonth());
  const [end, setEnd] = useState(monthUtils.currentMonth());

  useEffect(() => {
    const [initialStart, initialEnd] = calculateTimeRange(
      meta?.timeFrame,
      {
        start: monthUtils.currentMonth(),
        end: monthUtils.currentMonth(),
        mode: 'full',
      },
      '',
    );
    setStart(initialStart);
    setEnd(initialEnd);
  }, [meta?.timeFrame]);

  const params = useMemo(
    () =>
      comparisonSpreadsheet(
        start,
        end,
        meta?.metric || 'net_worth',
        meta?.conditions,
        meta?.conditionsOp,
      ),
    [start, end, meta?.metric, meta?.conditions, meta?.conditionsOp],
  );
  const data = useReport('comparison', params);

  const defaultName =
    meta?.metric === 'spending'
      ? t('Spending Comparison')
      : t('Net Worth Comparison');

  return (
    <ReportCard
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/comparison/${widgetId}`}
      menuItems={[
        {
          name: 'rename',
          text: t('Rename'),
        },
        {
          name: 'remove',
          text: t('Remove'),
        },
        ...copyMenuItems,
      ]}
      onMenuSelect={item => {
        if (handleCopyMenuSelect(item)) return;
        switch (item) {
          case 'rename':
            setNameMenuOpen(true);
            break;
          case 'remove':
            onRemove();
            break;
          default:
            throw new Error(`Unrecognized menu selection: ${item}`);
        }
      }}
    >
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <View style={{ flexGrow: 0, flexShrink: 0, padding: 20 }}>
          <ReportCardName
            name={meta?.name || defaultName}
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
          <DateRange
            start={data?.effectiveStart || start}
            end={data?.effectiveEnd || end}
          />
        </View>

        <View
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            flexGrow: 1,
            flexShrink: 1,
          }}
        >
          {data ? (
            <View
              style={{
                flex: 1,
                width: '100%',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <SummaryNumber
                value={data.delta}
                contentType="sum"
                loading={!data}
                animate={isEditing ?? false}
              />
            </View>
          ) : (
            <LoadingIndicator />
          )}
        </View>
      </View>
    </ReportCard>
  );
}