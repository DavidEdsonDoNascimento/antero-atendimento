import type { Metadata } from "next";

import { redirectIfAuthenticated } from "@/lib/auth/dal";

import { RequestResetForm } from "./request-reset-form";

export const metadata: Metadata = { title: "Recuperar senha" };

export default async function RecuperarSenhaPage() {
  await redirectIfAuthenticated();
  return <RequestResetForm />;
}
