"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import {
  autoCheckService,
  listVerificationStatus,
  recordManualConfirmation,
  recordVerificationResult,
} from "@/lib/domain-verification";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const ServiceNameSchema = z.object({ serviceName: z.string().min(1).max(64) });

export async function runVerificationCheckAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "infra.domain.verify" }, async () => {
    const user = await requireAdmin();
    const parsed = ServiceNameSchema.safeParse({
      serviceName: formData.get("serviceName"),
    });
    if (!parsed.success) throw new ValidationError("serviceName required");

    const result = await autoCheckService(parsed.data.serviceName);
    if (result.kind === "checked") {
      await recordVerificationResult(parsed.data.serviceName, {
        configuredUrl: result.configuredUrl,
        status: result.status,
        errorDetail: result.errorDetail,
      });
    }
    await writeAudit({
      actorId: user.id,
      action: "infra.domain.verification_surface_checked",
      targetType: "domain_verification",
      targetId: parsed.data.serviceName,
      after: {
        kind: result.kind,
        configuredUrl: result.configuredUrl,
        status: result.status,
        errorDetail: result.errorDetail ?? null,
      },
    });
    revalidatePath("/admin/system/domain-status");
  });
}

export async function runAllVerificationChecksAction(): Promise<ActionResult> {
  return withErrorBoundary({ action: "infra.domain.verify_all" }, async () => {
    const user = await requireAdmin();
    const rows = await listVerificationStatus();
    let verified = 0;
    let failed = 0;
    let manual = 0;
    for (const row of rows) {
      const result = await autoCheckService(row.serviceName);
      if (result.kind === "checked") {
        await recordVerificationResult(row.serviceName, {
          configuredUrl: result.configuredUrl,
          status: result.status,
          errorDetail: result.errorDetail,
        });
        if (result.status === "verified") verified++;
        else failed++;
      } else {
        manual++;
      }
    }
    await writeAudit({
      actorId: user.id,
      action: "infra.domain.verification_run",
      targetType: "domain_verification",
      targetId: "all",
      after: {
        totalRows: rows.length,
        verified,
        failed,
        manualOnly: manual,
      },
    });
    revalidatePath("/admin/system/domain-status");
  });
}

export async function markServiceConfirmedAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "infra.domain.confirm" }, async () => {
    const user = await requireAdmin();
    const parsed = ServiceNameSchema.safeParse({
      serviceName: formData.get("serviceName"),
    });
    if (!parsed.success) throw new ValidationError("serviceName required");

    await recordManualConfirmation(parsed.data.serviceName, user.id);
    await writeAudit({
      actorId: user.id,
      action: "infra.domain.manually_confirmed",
      targetType: "domain_verification",
      targetId: parsed.data.serviceName,
      after: { confirmedAt: new Date().toISOString() },
    });
    revalidatePath("/admin/system/domain-status");
  });
}
