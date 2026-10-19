import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminService } from '../admin.service';
import { UserRole } from '../../../utils/roles';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../../utils/errors';
import { captureError, resetErrorTracking } from '../../../lib/error-tracking';

describe('AdminService - Customer Support Tools (#250)', () => {
  let prismaMock: any;
  let adminService: AdminService;

  const adminId = 'admin-123';
  const targetUserId = 'user-456';

  beforeEach(() => {
    resetErrorTracking();

    prismaMock = {
      user: {
        findUnique: vi.fn(),
      },
      payment: {
        findMany: vi.fn(),
      },
      session: {
        findMany: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-log-1' }),
      },
    };

    adminService = new AdminService(prismaMock);
  });

  describe('getUserDetailsForSupport', () => {
    it('throws UnauthorizedError if caller is not an admin', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.FAN });

      await expect(
        adminService.getUserDetailsForSupport('fan-1', targetUserId)
      ).rejects.toThrow(UnauthorizedError);
    });

    it('throws NotFoundError if target user does not exist', async () => {
      // 1st call for isAdmin
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });
      // 2nd call for target user
      prismaMock.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        adminService.getUserDetailsForSupport(adminId, 'non-existent')
      ).rejects.toThrow(NotFoundError);
    });

    it('returns sanitized user info, recent payments, sessions, and errors, and records audit log', async () => {
      // Admin check
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });

      // Target user lookup
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: targetUserId,
        email: 'user@example.com',
        name: 'Target User',
        password: 'hashed-password-secret',
        role: UserRole.CREATOR,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        wallets: [{ id: 'w-1', publicKey: 'GBXYZ...', name: 'Primary Wallet', verified: true, createdAt: new Date() }],
        creator: { id: 'c-1', username: 'creator1', displayName: 'Creator One', verified: true, isPublic: true, createdAt: new Date() },
        userRoles: [{ role: { name: 'creator' } }],
      });

      // Payments lookup
      const mockPayments = [
        { id: 'p-1', amount: 100, status: 'succeeded', createdAt: new Date() },
      ];
      prismaMock.payment.findMany.mockResolvedValueOnce(mockPayments);

      // Sessions lookup
      const mockSessions = [
        { id: 's-1', ipAddress: '127.0.0.1', userAgent: 'Mozilla', createdAt: new Date(), expiresAt: new Date() },
      ];
      prismaMock.session.findMany.mockResolvedValueOnce(mockSessions);

      // Populate an error for this user
      captureError(new Error('Sample tracked error'), { userId: targetUserId, paymentId: 'p-1' });

      const result = await adminService.getUserDetailsForSupport(adminId, targetUserId, {
        ipAddress: '10.0.0.1',
        requestId: 'req-abc',
      });

      expect(result.user).toBeDefined();
      expect((result.user as any).password).toBeUndefined();
      expect(result.user.id).toBe(targetUserId);
      expect(result.user.email).toBe('user@example.com');
      expect(result.recentActivity.payments).toEqual(mockPayments);
      expect(result.recentActivity.logins).toEqual(mockSessions);
      expect(result.recentActivity.errors).toHaveLength(1);
      expect((result.recentActivity.errors[0] as any).context.userId).toBe(targetUserId);

      // Verify audit log creation
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: adminId,
          action: 'ADMIN_SUPPORT_VIEW_USER',
          resource: 'User',
          resourceId: targetUserId,
          changes: { targetUserId: { old: null, new: targetUserId } },
          ipAddress: '10.0.0.1',
          requestId: 'req-abc',
        },
      });
    });
  });

  describe('sendSupportTestCommunication', () => {
    it('throws UnauthorizedError if caller is not an admin', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.FAN });

      await expect(
        adminService.sendSupportTestCommunication('fan-1', targetUserId, {
          type: 'email',
          message: 'Hello',
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('throws NotFoundError if target user is not found', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });
      prismaMock.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        adminService.sendSupportTestCommunication(adminId, 'non-existent', {
          type: 'email',
          message: 'Hello',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid communication type', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: targetUserId });

      await expect(
        adminService.sendSupportTestCommunication(adminId, targetUserId, {
          type: 'sms' as any,
          message: 'Hello',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty message', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: targetUserId });

      await expect(
        adminService.sendSupportTestCommunication(adminId, targetUserId, {
          type: 'email',
          message: '   ',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('successfully delivers test communication and creates audit log', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ role: UserRole.ADMIN });
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: targetUserId,
        email: 'user@example.com',
        name: 'Target User',
      });

      const res = await adminService.sendSupportTestCommunication(
        adminId,
        targetUserId,
        {
          type: 'email',
          subject: 'Support test subject',
          message: 'This is a test notification from support.',
        },
        { ipAddress: '192.168.1.1', requestId: 'req-123' }
      );

      expect(res.success).toBe(true);
      expect(res.targetUserId).toBe(targetUserId);
      expect(res.type).toBe('email');
      expect(res.deliveredAt).toBeDefined();

      expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
        data: {
          userId: adminId,
          action: 'ADMIN_SUPPORT_SEND_TEST_COMMUNICATION',
          resource: 'User',
          resourceId: targetUserId,
          changes: {
            type: { old: null, new: 'email' },
            message: { old: null, new: 'This is a test notification from support.' },
            subject: { old: null, new: 'Support test subject' },
          },
          ipAddress: '192.168.1.1',
          requestId: 'req-123',
        },
      });
    });
  });
});
