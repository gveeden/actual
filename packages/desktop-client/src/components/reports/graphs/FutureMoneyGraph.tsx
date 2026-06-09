import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { css } from '@emotion/css';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { FinancialText } from '#components/FinancialText';
import { useRechartsAnimation } from '#components/reports/chart-theme';
import { Container } from '#components/reports/Container';
import { useFormat } from '#hooks/useFormat';
import { usePrivacyMode } from '#hooks/usePrivacyMode';

type PayloadItem = {
  payload: {
    x: string;
    y: number;
    isProjection: boolean;
    income?: number;
    expenses?: number;
    change?: number;
  };
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: PayloadItem[];
};

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  const { t } = useTranslation();
  const format = useFormat();

  if (active && payload && payload.length) {
    const item = payload[0].payload;
    return (
      <div
        className={css({
          zIndex: 1000,
          pointerEvents: 'none',
          borderRadius: 2,
          boxShadow: '0 1px 6px rgba(0, 0, 0, .20)',
          backgroundColor: theme.menuBackground,
          color: theme.menuItemText,
          padding: 10,
        })}
      >
        <div>
          <div style={{ marginBottom: 10 }}>
            <strong>{item.x}</strong>
            {item.isProjection ? (
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                {t('(projected)')}
              </span>
            ) : null}
          </div>
          <div style={{ lineHeight: 1.5 }}>
            {item.income !== undefined && (
              <View
                className={css({
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: theme.noticeText,
                })}
              >
                <div>
                  <Trans>Income:</Trans>
                </div>
                <div style={{ marginLeft: 20 }}>
                  <FinancialText>{format(item.income, 'financial')}</FinancialText>
                </div>
              </View>
            )}
            {item.expenses !== undefined && (
              <View
                className={css({
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: theme.errorText,
                })}
              >
                <div>
                  <Trans>Expenses:</Trans>
                </div>
                <div style={{ marginLeft: 20 }}>
                  <FinancialText>{format(item.expenses, 'financial')}</FinancialText>
                </div>
              </View>
            )}
            {item.change !== undefined && (
              <View
                className={css({
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 5,
                })}
              >
                <div>
                  <Trans>Change:</Trans>
                </div>
                <div style={{ marginLeft: 20 }}>
                  <FinancialText>{format(item.change, 'financial')}</FinancialText>
                </div>
              </View>
            )}
            <View
              className={css({
                display: 'flex',
                justifyContent: 'space-between',
                fontWeight: 'bold',
                borderTop:
                  item.change !== undefined
                    ? `1px solid ${theme.menuBorder}`
                    : 'none',
                paddingTop: item.change !== undefined ? 5 : 0,
              })}
            >
              <div>
                <Trans>Balance:</Trans>
              </div>
              <div style={{ marginLeft: 20 }}>
                <FinancialText>{format(item.y, 'financial')}</FinancialText>
              </div>
            </View>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

type FutureMoneyGraphProps = {
  style?: CSSProperties;
  graphData: Array<{
    x: string;
    y: number;
    isProjection: boolean;
  }>;
  compact?: boolean;
  showTooltip?: boolean;
};

export function FutureMoneyGraph({
  style,
  graphData,
  compact = false,
  showTooltip = true,
}: FutureMoneyGraphProps) {
  const privacyMode = usePrivacyMode();
  const format = useFormat();
  const animationProps = useRechartsAnimation({ isAnimationActive: false });

  const tickFormatter = (tick: number) => {
    if (privacyMode) {
      return '...';
    }
    return `${format(Math.round(tick), 'financial-no-decimals')}`;
  };

  const chartData = graphData.map((d, i) => {
    const isLastHistorical =
      !d.isProjection && (graphData[i + 1]?.isProjection ?? false);
    return {
      ...d,
      historicalY: d.isProjection ? null : d.y,
      projectedY: d.isProjection || isLastHistorical ? d.y : null,
    };
  });

  const todayPoint =
    graphData.find(
      (d, i) => !d.isProjection && (graphData[i + 1]?.isProjection ?? false),
    ) || graphData[graphData.length - 1];

  return (
    <Container
      style={{
        ...style,
        ...(compact && { height: 'auto' }),
      }}
    >
      {(width, height) => (
        <LineChart
          width={Math.max(0, width)}
          height={Math.max(0, height)}
          data={chartData}
          margin={{
            top: compact ? 0 : 15,
            right: 0,
            left: compact ? 0 : 20,
            bottom: compact ? 0 : 10,
          }}
        >
          {!compact && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis
            dataKey="x"
            hide={compact}
            tick={{ fill: theme.pageText }}
            tickLine={{ stroke: theme.pageText }}
          />
          <YAxis
            hide={compact}
            tickFormatter={tickFormatter}
            tick={{ fill: theme.pageText }}
            tickLine={{ stroke: theme.pageText }}
          />
          {showTooltip && (
            <Tooltip content={<CustomTooltip />} isAnimationActive={false} />
          )}

          {todayPoint && (
            <ReferenceLine
              x={todayPoint.x}
              stroke={theme.noticeText}
              strokeDasharray="3 3"
            />
          )}

          <Line
            type="monotone"
            dataKey="historicalY"
            dot={false}
            stroke={theme.reportsNumberPositive}
            strokeWidth={2}
            {...animationProps}
          />
          <Line
            type="monotone"
            dataKey="projectedY"
            dot={false}
            stroke={theme.reportsNumberPositive}
            strokeWidth={2}
            strokeDasharray="5 5"
            {...animationProps}
          />
        </LineChart>
      )}
    </Container>
  );
}
