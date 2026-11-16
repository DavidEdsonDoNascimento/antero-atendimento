import { z } from "zod";

import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { getFlowImageContent } from "@/modules/automations/sql-queries";

/**
 * Imagem de um fluxo, para o editor e a prévia. Só para membro ativo da
 * organização dona, com o módulo Automações (DAL + RLS de `automation_media`).
 * O id não muda de conteúdo (imagens não são alteradas): cache privado longo.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const context = organizationContextOf(await requireModule("automacoes"));
  const mediaId = z.uuid().safeParse((await params).mediaId);
  if (!mediaId.success) return new Response("Não encontrada.", { status: 404 });
  const image = await getFlowImageContent(context, mediaId.data);
  if (!image) return new Response("Não encontrada.", { status: 404 });
  return new Response(new Uint8Array(image.data), {
    headers: {
      "content-type": image.contentType,
      "content-length": String(image.data.length),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
