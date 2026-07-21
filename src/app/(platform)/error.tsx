"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Registra o erro no servidor/observabilidade sem expor dados sensíveis.
    console.error(error);
  }, [error]);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">
            Algo deu errado
          </h1>
          <p className="text-sm text-muted">
            Não foi possível carregar esta página. Tente novamente.
          </p>
        </div>
        <Button variant="secondary" onClick={reset}>
          Tentar novamente
        </Button>
      </CardContent>
    </Card>
  );
}
