import type { Metadata } from "next";

import { UpdatePasswordForm } from "./update-password-form";

export const metadata: Metadata = { title: "Redefinir senha" };

export default function RedefinirSenhaPage() {
  return <UpdatePasswordForm />;
}
