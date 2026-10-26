import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";

import { UpdatePasswordForm } from "./update-password-form";

// `no-referrer`: o token de redefinição está na URL desta página.
export const metadata: Metadata = { title: "Redefinir senha", referrer: "no-referrer" };

// Token emitido pelo Better Auth (alfanumérico). Qualquer outra coisa é
// tratada como link inválido, sem ir ao servidor.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Destino do link do e-mail: `/api/auth/reset-password/<token>` confere o
 * token e redireciona para cá com `?token=` (válido) ou `?error=INVALID_TOKEN`
 * (inexistente, expirado ou já usado). A troca em si é validada de novo pelo
 * handler ao enviar o formulário.
 */
export default async function RedefinirSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" && TOKEN_FORMAT.test(params.token) ? params.token : null;

  if (!token || params.error !== undefined) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-foreground">
              Link inválido ou expirado
            </h1>
            <p className="text-sm text-muted">
              Este link de redefinição de senha não é mais válido. Os links
              valem por uma hora e podem ser usados uma única vez.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-center text-sm">
            <Link
              href="/recuperar-senha"
              className="text-gold transition-colors hover:text-gold-soft"
            >
              Solicitar um novo link
            </Link>
            <Link
              href="/login"
              className="text-muted transition-colors hover:text-gold"
            >
              Voltar para o login
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return <UpdatePasswordForm token={token} />;
}
