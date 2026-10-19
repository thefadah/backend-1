-- AlterTable Creator: Add customFeeOverride (Issue #234)
ALTER TABLE "Creator" ADD COLUMN "customFeeOverride" DOUBLE PRECISION;

-- CreateTable PayoutStatusLog (Issue #235)
CREATE TABLE "PayoutStatusLog" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "fromStatus" "PayoutStatus",
    "toStatus" "PayoutStatus" NOT NULL,
    "reason" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_payoutStatusLog_payout_createdAt" ON "PayoutStatusLog"("payoutId", "createdAt");

-- AddForeignKey for PayoutStatusLog
ALTER TABLE "PayoutStatusLog" ADD CONSTRAINT "PayoutStatusLog_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add missing ForeignKeys for referential integrity (Issue #244)
-- VerificationToken -> User
ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SubscriptionCharge -> Tip
ALTER TABLE "SubscriptionCharge" ADD CONSTRAINT "SubscriptionCharge_tipId_fkey" FOREIGN KEY ("tipId") REFERENCES "Tip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Report -> User
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ReportAppeal -> User
ALTER TABLE "ReportAppeal" ADD CONSTRAINT "ReportAppeal_appellantId_fkey" FOREIGN KEY ("appellantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ScheduledPayment -> Payout
ALTER TABLE "ScheduledPayment" ADD CONSTRAINT "ScheduledPayment_lastPayoutId_fkey" FOREIGN KEY ("lastPayoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
