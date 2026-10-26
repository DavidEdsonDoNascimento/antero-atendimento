"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";

/**
 * Erros fora da área da plataforma — inclusive no layout da plataforma (ex.:
 * banco ou serviço de identidade indisponível ao validar a sessão). Mensagem
 * neutra: em produção o Next.js não envia ao navegador o texto do erro do
 * servidor (só um `digest`), então nada de SQL, stack ou credencial aparece.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-foreground">
                Serviço temporariamente indisponível
              </h1>
              <p className="text-sm text-muted">
                Não foi possível carregar esta página agora. Aguarde alguns
                instantes e tente novamente.
              </p>
            </div>
            <Button variant="secondary" onClick={() => retry()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
