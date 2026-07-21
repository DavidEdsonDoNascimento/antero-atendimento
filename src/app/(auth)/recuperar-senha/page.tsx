import type { Metadata } from "next";

import { RequestResetForm } from "./request-reset-form";

export const metadata: Metadata = { title: "Recuperar senha" };

export default function RecuperarSenhaPage() {
  return <RequestResetForm />;
}
