"use client";

import { SubmitButton } from "@/components/ui/submit-button";
import { signOut } from "@/modules/auth/browser-actions";

/** Botão "Sair" das telas fora da plataforma (ex.: /sem-organizacao). */
export function SignOutForm() {
  return (
    <form action={signOut}>
      <SubmitButton variant="secondary" pendingLabel="Saindo…">
        Sair
      </SubmitButton>
    </form>
  );
}
