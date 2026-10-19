import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreatorService } from '../creator.service';
import { AdminService } from '../../admin/admin.service';

describe('Creator Verification Badge System (#248)', () => {
  let prismaMock: any;
  let creatorService: CreatorService;
  let adminService: AdminService;

  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock = {
      creator: {
        findUnique: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (cb) => cb(prismaMock)),
    };

    creatorService = new CreatorService(prismaMock);
    adminService = new AdminService(prismaMock);
  });

  it('formats verified creator with badge object and verificationBadge: true', async () => {
    prismaMock.creator.findUnique.mockResolvedValue({
      id: 'creator-1',
      username: 'alice',
      displayName: 'Alice',
      verified: true,
      totalEarnings: 1000,
    });

    const creator = await creatorService.getCreatorByUsername('alice');

    expect(creator.verified).toBe(true);
    expect(creator.verificationBadge).toBe(true);
    expect(creator.badge).toEqual({
      verified: true,
      type: 'verified',
    });
  });

  it('formats unverified creator with badge: null and verificationBadge: false', async () => {
    prismaMock.creator.findUnique.mockResolvedValue({
      id: 'creator-2',
      username: 'bob',
      displayName: 'Bob',
      verified: false,
      totalEarnings: 0,
    });

    const creator = await creatorService.getCreatorByUsername('bob');

    expect(creator.verified).toBe(false);
    expect(creator.verificationBadge).toBe(false);
    expect(creator.badge).toBeNull();
  });

  it('allows admin to verify creator and records audit log', async () => {
    prismaMock.creator.findUnique.mockResolvedValue({
      id: 'creator-1',
      username: 'alice',
      verified: false,
    });

    prismaMock.creator.update.mockResolvedValue({
      id: 'creator-1',
      username: 'alice',
      verified: true,
    });

    const result = await adminService.verifyCreatorDirect(
      'creator-1',
      { verified: true, badgeType: 'verified', notes: 'Identity documents reviewed' },
      'admin-123'
    );

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.badge).toEqual({ verified: true, type: 'verified' });
    expect(prismaMock.creator.update).toHaveBeenCalledWith({
      where: { id: 'creator-1' },
      data: { verified: true },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'admin-123',
          action: 'creator.verify',
          targetId: 'creator-1',
        }),
      })
    );
  });
});
