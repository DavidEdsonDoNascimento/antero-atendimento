"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/dal";

import { setOrganizationStatus } from "./sql-queries";

const inputSchema = z.object({
  organizationId: z.uuid(),
  status: z.enum(["active", "inactive"]),
});

/**
 * Suspende ou reativa uma organização. Server Actions aceitam POST direto, sem
 * passar pela interface: o papel é conferido aqui (DAL) e de novo no banco
 * (`public.set_organization_status`), e o `userId` sai só da sessão validada.
 */
export async function setOrganizationStatusAction(formData: FormData): Promise<void> {
  const profile = await requirePlatformAdmin();
  const input = inputSchema.parse({
    organizationId: formData.get("organizationId"),
    status: formData.get("status"),
  });
  await setOrganizationStatus({ userId: profile.id, ...input });
  revalidatePath("/admin");
}
