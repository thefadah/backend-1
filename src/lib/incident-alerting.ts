import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import { TrackedError } from './error-tracking';

export interface IncidentAlertContext {
  userId?: string;
  paymentId?: string;
  requestId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  [key: string]: unknown;
}

export interface IncidentAlertRecord {
  id: string;
  trigger: 'threshold_exceeded' | 'critical_error_type';
  severity: 'warning' | 'error' | 'critical';
  title: string;
  errorCount?: number;
  windowMs?: number;
  errorDetails: {
    id: string;
    code: string;
    message: string;
    statusCode: number;
    stack?: string;
  };
  context: IncidentAlertContext;
  channelsNotified: string[];
  timestamp: string;
  status: 'triggered' | 'resolved';
}

export type SlackTransport = (alert: IncidentAlertRecord, webhookUrl: string) => Promise<void>;
export type PagerDutyTransport = (alert: IncidentAlertRecord, routingKey: string) => Promise<void>;

export interface IncidentAlertConfig {
  enabled: boolean;
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  criticalErrorCodes: Set<string>;
  slackWebhookUrl?: string;
  pagerDutyIntegrationKey?: string;
  slackTransport: SlackTransport;
  pagerDutyTransport: PagerDutyTransport;
}

const DEFAULT_THRESHOLD = 10;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown between threshold alerts
const DEFAULT_HISTORY_SIZE = 100;

export const DEFAULT_CRITICAL_ERROR_CODES = new Set<string>([
  'DATABASE_UNAVAILABLE',
  'PAYMENT_FAILURE',
  'PAYMENT_FAILED',
  'PAYMENT_ERROR',
  'PAYMENT_PROCESSING_FAILED',
  'STELLAR_ERROR',
  'HORIZON_ERROR',
  'CIRCUIT_BREAKER_OPEN',
  'SECURITY_ALERT',
  'RATE_LIMIT_CRITICAL',
]);

export const defaultSlackTransport: SlackTransport = async (alert, webhookUrl) => {
  try {
    const payload = {
      text: `🚨 [${alert.severity.toUpperCase()}] ${alert.title}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `🚨 ${alert.title}`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Severity:*\n${alert.severity}` },
            { type: 'mrkdwn', text: `*Trigger:*\n${alert.trigger}` },
            { type: 'mrkdwn', text: `*Error Code:*\n${alert.errorDetails.code}` },
            { type: 'mrkdwn', text: `*Status Code:*\n${alert.errorDetails.statusCode}` },
            { type: 'mrkdwn', text: `*User ID:*\n${alert.context.userId ?? 'N/A'}` },
            { type: 'mrkdwn', text: `*Payment ID:*\n${alert.context.paymentId ?? 'N/A'}` },
            { type: 'mrkdwn', text: `*Request ID:*\n${alert.context.requestId ?? 'N/A'}` },
            { type: 'mrkdwn', text: `*Endpoint:*\n${alert.context.method ?? ''} ${alert.context.url ?? 'N/A'}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Error Message:*\n\`\`\`${alert.errorDetails.message}\`\`\``,
          },
        },
      ],
    };

    await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to dispatch Slack incident alert');
  }
};

export const defaultPagerDutyTransport: PagerDutyTransport = async (alert, routingKey) => {
  try {
    const payload = {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: `incident-${alert.errorDetails.code}-${alert.trigger}`,
      payload: {
        summary: `[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.errorDetails.message}`,
        severity: alert.severity === 'critical' ? 'critical' : 'error',
        source: 'dorisio-backend',
        timestamp: alert.timestamp,
        custom_details: {
          errorId: alert.errorDetails.id,
          code: alert.errorDetails.code,
          message: alert.errorDetails.message,
          statusCode: alert.errorDetails.statusCode,
          userId: alert.context.userId,
          paymentId: alert.context.paymentId,
          requestId: alert.context.requestId,
          url: alert.context.url,
          method: alert.context.method,
          trigger: alert.trigger,
          errorCount: alert.errorCount,
        },
      },
    };

    await axios.post('https://events.pagerduty.com/v2/enqueue', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to dispatch PagerDuty incident alert');
  }
};

let currentConfig: IncidentAlertConfig = {
  enabled: true,
  threshold: DEFAULT_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  criticalErrorCodes: new Set(DEFAULT_CRITICAL_ERROR_CODES),
  slackWebhookUrl: process.env.SLACK_ALERT_WEBHOOK_URL,
  pagerDutyIntegrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
  slackTransport: defaultSlackTransport,
  pagerDutyTransport: defaultPagerDutyTransport,
};

const errorTimestamps: number[] = [];
const alertHistory: IncidentAlertRecord[] = [];
let lastThresholdAlertAt = 0;

export function configureIncidentAlerting(overrides: Partial<IncidentAlertConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...overrides,
    criticalErrorCodes: overrides.criticalErrorCodes
      ? new Set(overrides.criticalErrorCodes)
      : currentConfig.criticalErrorCodes,
  };
}

export function resetIncidentAlerting(): void {
  currentConfig = {
    enabled: true,
    threshold: DEFAULT_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    criticalErrorCodes: new Set(DEFAULT_CRITICAL_ERROR_CODES),
    slackWebhookUrl: process.env.SLACK_ALERT_WEBHOOK_URL,
    pagerDutyIntegrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
    slackTransport: defaultSlackTransport,
    pagerDutyTransport: defaultPagerDutyTransport,
  };
  errorTimestamps.length = 0;
  alertHistory.length = 0;
  lastThresholdAlertAt = 0;
}

export function getAlertHistory(limit = alertHistory.length): IncidentAlertRecord[] {
  const count = Math.max(0, Math.min(limit, alertHistory.length));
  return alertHistory.slice(alertHistory.length - count);
}

export function clearAlertHistory(): void {
  alertHistory.length = 0;
}

async function dispatchAlert(alert: IncidentAlertRecord): Promise<void> {
  const notifications: Promise<void>[] = [];

  if (currentConfig.slackWebhookUrl) {
    alert.channelsNotified.push('slack');
    notifications.push(currentConfig.slackTransport(alert, currentConfig.slackWebhookUrl));
  }

  if (currentConfig.pagerDutyIntegrationKey) {
    alert.channelsNotified.push('pagerduty');
    notifications.push(
      currentConfig.pagerDutyTransport(alert, currentConfig.pagerDutyIntegrationKey)
    );
  }

  await Promise.allSettled(notifications);
}

export async function processErrorForIncidentAlerting(
  error: TrackedError
): Promise<IncidentAlertRecord | null> {
  if (!currentConfig.enabled) return null;

  const now = Date.now();
  errorTimestamps.push(now);

  // Evict timestamps outside the sliding window
  const windowStart = now - currentConfig.windowMs;
  while (errorTimestamps.length > 0 && errorTimestamps[0] < windowStart) {
    errorTimestamps.shift();
  }

  const isCriticalType =
    currentConfig.criticalErrorCodes.has(error.code) ||
    error.context.critical === true ||
    (error.statusCode >= 500 && !error.operational && error.code.includes('DATABASE'));

  let alert: IncidentAlertRecord | null = null;

  if (isCriticalType) {
    alert = {
      id: randomUUID(),
      trigger: 'critical_error_type',
      severity: 'critical',
      title: `Critical Incident: ${error.code}`,
      errorDetails: {
        id: error.id,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        stack: error.stack,
      },
      context: {
        ...error.context,
        userId: error.context.userId,
        paymentId: (error.context.paymentId as string | undefined) ?? (error.context.payment_id as string | undefined),
        requestId: error.context.requestId,
        method: error.context.method,
        url: error.context.url,
      },
      channelsNotified: [],
      timestamp: new Date().toISOString(),
      status: 'triggered',
    };
  } else if (
    errorTimestamps.length >= currentConfig.threshold &&
    now - lastThresholdAlertAt >= currentConfig.cooldownMs
  ) {
    lastThresholdAlertAt = now;
    alert = {
      id: randomUUID(),
      trigger: 'threshold_exceeded',
      severity: 'error',
      title: `Error Threshold Exceeded: ${errorTimestamps.length} errors in ${Math.round(currentConfig.windowMs / 60000)}m`,
      errorCount: errorTimestamps.length,
      windowMs: currentConfig.windowMs,
      errorDetails: {
        id: error.id,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        stack: error.stack,
      },
      context: {
        ...error.context,
        userId: error.context.userId,
        paymentId: (error.context.paymentId as string | undefined) ?? (error.context.payment_id as string | undefined),
        requestId: error.context.requestId,
        method: error.context.method,
        url: error.context.url,
      },
      channelsNotified: [],
      timestamp: new Date().toISOString(),
      status: 'triggered',
    };
  }

  if (alert) {
    alertHistory.push(alert);
    while (alertHistory.length > DEFAULT_HISTORY_SIZE) {
      alertHistory.shift();
    }
    await dispatchAlert(alert);
    return alert;
  }

  return null;
}
