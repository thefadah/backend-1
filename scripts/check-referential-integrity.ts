import { PrismaClient } from '@prisma/client';

/**
 * Script to audit referential integrity across all database foreign key relationships (issue #244).
 * Checks for orphaned records and ensures referential constraints are satisfied.
 */
async function main() {
  const prisma = new PrismaClient();
  console.log('🔍 Starting database referential integrity audit...');

  let totalOrphans = 0;

  try {
    // 1. Audit VerificationToken -> User
    const orphanedTokens = await prisma.verificationToken.findMany({
      where: {
        userId: { not: null },
        user: null,
      },
      select: { id: true, userId: true },
    });
    if (orphanedTokens.length > 0) {
      console.warn(`Found ${orphanedTokens.length} orphaned VerificationToken records. Cleaning...`);
      await prisma.verificationToken.deleteMany({
        where: { id: { in: orphanedTokens.map((t) => t.id) } },
      });
      totalOrphans += orphanedTokens.length;
    }

    // 2. Audit ScheduledPayment -> Payout
    const orphanedScheduledPayouts = await prisma.scheduledPayment.findMany({
      where: {
        lastPayoutId: { not: null },
        lastPayout: null,
      },
      select: { id: true },
    });
    if (orphanedScheduledPayouts.length > 0) {
      console.warn(`Found ${orphanedScheduledPayouts.length} ScheduledPayments with invalid lastPayoutId. Nulling...`);
      await prisma.scheduledPayment.updateMany({
        where: { id: { in: orphanedScheduledPayouts.map((s) => s.id) } },
        data: { lastPayoutId: null },
      });
      totalOrphans += orphanedScheduledPayouts.length;
    }

    // 3. Audit SubscriptionCharge -> Tip
    const orphanedCharges = await prisma.subscriptionCharge.findMany({
      where: {
        tipId: { not: null },
        tip: null,
      },
      select: { id: true },
    });
    if (orphanedCharges.length > 0) {
      console.warn(`Found ${orphanedCharges.length} SubscriptionCharges with invalid tipId. Nulling...`);
      await prisma.subscriptionCharge.updateMany({
        where: { id: { in: orphanedCharges.map((c) => c.id) } },
        data: { tipId: null },
      });
      totalOrphans += orphanedCharges.length;
    }

    // 4. Audit Report -> User
    const orphanedReports = await prisma.report.findMany({
      where: {
        reporter: null,
      },
      select: { id: true },
    });
    if (orphanedReports.length > 0) {
      console.warn(`Found ${orphanedReports.length} orphaned Report records. Cleaning...`);
      await prisma.report.deleteMany({
        where: { id: { in: orphanedReports.map((r) => r.id) } },
      });
      totalOrphans += orphanedReports.length;
    }

    // 5. Audit ReportAppeal -> User
    const orphanedAppeals = await prisma.reportAppeal.findMany({
      where: {
        appellant: null,
      },
      select: { id: true },
    });
    if (orphanedAppeals.length > 0) {
      console.warn(`Found ${orphanedAppeals.length} orphaned ReportAppeal records. Cleaning...`);
      await prisma.reportAppeal.deleteMany({
        where: { id: { in: orphanedAppeals.map((a) => a.id) } },
      });
      totalOrphans += orphanedAppeals.length;
    }

    // 6. Audit PayoutStatusLog -> Payout
    const orphanedPayoutLogs = await (prisma as any).payoutStatusLog.findMany({
      where: {
        payout: null,
      },
      select: { id: true },
    });
    if (orphanedPayoutLogs.length > 0) {
      console.warn(`Found ${orphanedPayoutLogs.length} orphaned PayoutStatusLog records. Cleaning...`);
      await (prisma as any).payoutStatusLog.deleteMany({
        where: { id: { in: orphanedPayoutLogs.map((l: any) => l.id) } },
      });
      totalOrphans += orphanedPayoutLogs.length;
    }

    console.log(`✅ Referential integrity audit completed. Total orphaned records cleaned: ${totalOrphans}`);
  } catch (error) {
    console.error('❌ Referential integrity check encountered an error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.NODE_ENV !== 'test') {
  main();
}
