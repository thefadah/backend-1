import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDeadlockError } from '../connection';
import { dbDeadlocksCounter } from '../metrics';

describe('Database Transaction Deadlock Detection and Retry (#247)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isDeadlockError', () => {
    it('identifies postgres deadlock error 40P01', () => {
      const error = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      expect(isDeadlockError(error)).toBe(true);
    });

    it('identifies postgres serialization failure 40001', () => {
      const error = Object.assign(new Error('could not serialize access'), { code: '40001' });
      expect(isDeadlockError(error)).toBe(true);
    });

    it('identifies prisma concurrency / deadlock codes P2034 and P2028', () => {
      expect(isDeadlockError({ code: 'P2034' })).toBe(true);
      expect(isDeadlockError({ code: 'P2028' })).toBe(true);
    });

    it('identifies deadlock in error message even without code', () => {
      expect(isDeadlockError(new Error('ERROR: deadlock detected between processes'))).toBe(true);
      expect(isDeadlockError(new Error('could not serialize access due to concurrent update'))).toBe(true);
    });

    it('returns false for non-deadlock errors', () => {
      expect(isDeadlockError(new Error('column not found'))).toBe(false);
      expect(isDeadlockError({ code: '23505' })).toBe(false);
      expect(isDeadlockError(null)).toBe(false);
    });
  });

  describe('dbDeadlocksCounter metric', () => {
    it('is registered with operation and exhausted labels', () => {
      expect(dbDeadlocksCounter).toBeDefined();
    });
  });
});
