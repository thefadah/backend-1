import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  configureIncidentAlerting,
  resetIncidentAlerting,
  processErrorForIncidentAlerting,
  getAlertHistory,
  clearAlertHistory,
  IncidentAlertRecord,
} from '../incident-alerting';
import { captureError, resetErrorTracking } from '../error-tracking';

describe('Automated Incident Alerting (#249)', () => {
  let mockSlackTransport: ReturnType<typeof vi.fn>;
  let mockPagerDutyTransport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetErrorTracking();
    resetIncidentAlerting();
    clearAlertHistory();

    mockSlackTransport = vi.fn().mockResolvedValue(undefined);
    mockPagerDutyTransport = vi.fn().mockResolvedValue(undefined);

    configureIncidentAlerting({
      enabled: true,
      threshold: 10,
      windowMs: 5 * 60 * 1000,
      cooldownMs: 0,
      slackWebhookUrl: 'https://hooks.slack.com/services/mock/alert',
      pagerDutyIntegrationKey: 'mock-pagerduty-routing-key',
      slackTransport: mockSlackTransport,
      pagerDutyTransport: mockPagerDutyTransport,
    });
  });

  it('triggers an alert when error threshold (10+ errors in 5 min) is exceeded', async () => {
    // Fire 9 non-critical errors (below threshold of 10)
    for (let i = 1; i <= 9; i++) {
      const alert = await processErrorForIncidentAlerting({
        id: `err-${i}`,
        code: 'BAD_REQUEST',
        message: `Validation failure ${i}`,
        statusCode: 400,
        operational: true,
        timestamp: new Date().toISOString(),
        context: { userId: 'user-123' },
      });
      expect(alert).toBeNull();
    }

    expect(getAlertHistory()).toHaveLength(0);
    expect(mockSlackTransport).not.toHaveBeenCalled();
    expect(mockPagerDutyTransport).not.toHaveBeenCalled();

    // 10th error triggers threshold alert
    const alert = await processErrorForIncidentAlerting({
      id: 'err-10',
      code: 'INTERNAL_ERROR',
      message: 'Rate limit or server error',
      statusCode: 500,
      operational: false,
      timestamp: new Date().toISOString(),
      context: { userId: 'user-123', requestId: 'req-10', paymentId: 'pay-456' },
    });

    expect(alert).not.toBeNull();
    expect(alert?.trigger).toBe('threshold_exceeded');
    expect(alert?.errorCount).toBe(10);
    expect(alert?.context.userId).toBe('user-123');
    expect(alert?.context.paymentId).toBe('pay-456');

    // Slack and PagerDuty transports called
    expect(mockSlackTransport).toHaveBeenCalledTimes(1);
    expect(mockSlackTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'threshold_exceeded',
        context: expect.objectContaining({ userId: 'user-123', paymentId: 'pay-456' }),
      }),
      'https://hooks.slack.com/services/mock/alert'
    );

    expect(mockPagerDutyTransport).toHaveBeenCalledTimes(1);
    expect(mockPagerDutyTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'threshold_exceeded',
      }),
      'mock-pagerduty-routing-key'
    );

    // Alert history tracks the incident
    const history = getAlertHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(alert?.id);
    expect(history[0].status).toBe('triggered');
  });

  it('triggers immediate alert on specific critical error types with full context', async () => {
    const alert = await processErrorForIncidentAlerting({
      id: 'err-crit-1',
      code: 'DATABASE_UNAVAILABLE',
      message: 'Connection pool exhausted, database unavailable',
      statusCode: 503,
      operational: false,
      timestamp: new Date().toISOString(),
      context: {
        userId: 'usr-999',
        paymentId: 'pay-777',
        requestId: 'req-crit-1',
        url: '/api/v1/payments/process',
        method: 'POST',
      },
      stack: 'Error: Connection pool exhausted\n at query (db.ts:42)',
    });

    expect(alert).not.toBeNull();
    expect(alert?.trigger).toBe('critical_error_type');
    expect(alert?.severity).toBe('critical');
    expect(alert?.errorDetails.code).toBe('DATABASE_UNAVAILABLE');
    expect(alert?.context.userId).toBe('usr-999');
    expect(alert?.context.paymentId).toBe('pay-777');
    expect(alert?.context.url).toBe('/api/v1/payments/process');

    expect(mockSlackTransport).toHaveBeenCalledTimes(1);
    expect(mockPagerDutyTransport).toHaveBeenCalledTimes(1);

    const history = getAlertHistory();
    expect(history).toHaveLength(1);
    expect(history[0].errorDetails.message).toContain('Connection pool exhausted');
  });

  it('triggers immediate alert on PAYMENT_FAILURE errors', async () => {
    const alert = await processErrorForIncidentAlerting({
      id: 'err-pay-1',
      code: 'PAYMENT_FAILURE',
      message: 'Stellar transaction submission failed: tx_insufficient_balance',
      statusCode: 500,
      operational: false,
      timestamp: new Date().toISOString(),
      context: {
        userId: 'creator-42',
        paymentId: 'pay-sub-1',
      },
    });

    expect(alert).not.toBeNull();
    expect(alert?.trigger).toBe('critical_error_type');
    expect(alert?.errorDetails.code).toBe('PAYMENT_FAILURE');
    expect(mockSlackTransport).toHaveBeenCalledTimes(1);
  });

  it('automatically triggers incident alerting through captureError', async () => {
    captureError(new Error('Stellar horizon timeout'), {
      code: 'STELLAR_ERROR',
      statusCode: 504,
      userId: 'usr-auto-1',
      paymentId: 'pay-auto-1',
    });

    // Wait microtask tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getAlertHistory()).toHaveLength(1);
    expect(mockSlackTransport).toHaveBeenCalledTimes(1);
    expect(mockPagerDutyTransport).toHaveBeenCalledTimes(1);
  });

  it('allows disabling alerting via configuration', async () => {
    configureIncidentAlerting({ enabled: false });

    const alert = await processErrorForIncidentAlerting({
      id: 'err-disabled',
      code: 'DATABASE_UNAVAILABLE',
      message: 'DB down',
      statusCode: 503,
      operational: false,
      timestamp: new Date().toISOString(),
      context: {},
    });

    expect(alert).toBeNull();
    expect(mockSlackTransport).not.toHaveBeenCalled();
    expect(getAlertHistory()).toHaveLength(0);
  });
});
