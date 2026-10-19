import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminService } from '../admin.service';
import { ValidationError } from '../../../utils/errors';

describe('Admin Bulk Refund (#245)', () => {
  let adminService: AdminService;
  let prismaMock: any;

  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock = {
      payment: {
        findMany: vi.fn(),
      },
      refund: {
        create: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb) => cb(prismaMock)),
    };

    adminService = new AdminService(prismaMock);
  });

  it('rejects empty paymentIds array', async () => {
    await expect(
      adminService.bulkRefundPayments({ paymentIds: [] }, 'admin-1')
    ).rejects.toThrow(ValidationError);
  });

  it('fails fast when a payment does not exist', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { id: 'pay-1', amount: 50, status: 'succeeded', refunds: [] },
    ]);

    const result = await adminService.bulkRefundPayments(
      { paymentIds: ['pay-1', 'pay-missing'] },
      'admin-1'
    );

    expect(result.total).toBe(2);
    expect(result.refunded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paymentId: 'pay-missing', status: 'failed', error: 'Payment not found' }),
      ])
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('fails fast when a payment has non-refundable status or zero balance', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { id: 'pay-1', amount: 50, status: 'failed', refunds: [] },
    ]);

    const result = await adminService.bulkRefundPayments(
      { paymentIds: ['pay-1'] },
      'admin-1'
    );

    expect(result.refunded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain('is not refundable');
  });

  it('successfully executes atomic bulk refund when all payments are valid', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { id: 'pay-1', amount: 50, currency: 'USD', status: 'succeeded', refunds: [] },
      { id: 'pay-2', amount: 75, currency: 'EUR', status: 'succeeded', refunds: [] },
    ]);

    prismaMock.refund.create
      .mockResolvedValueOnce({ id: 'ref-1', paymentId: 'pay-1', amount: 50 })
      .mockResolvedValueOnce({ id: 'ref-2', paymentId: 'pay-2', amount: 75 });

    prismaMock.payment.update = vi.fn().mockResolvedValue({});
    prismaMock.paymentEvent = { create: vi.fn().mockResolvedValue({}) };

    const result = await adminService.bulkRefundPayments(
      { paymentIds: ['pay-1', 'pay-2'], reason: 'Fraudulent activity batch' },
      'admin-1'
    );

    expect(result.total).toBe(2);
    expect(result.refunded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(prismaMock.refund.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });
});
