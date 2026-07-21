import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const notice =
    params.erro === "link"
      ? "O link expirou ou é inválido. Faça login normalmente ou solicite um novo."
      : undefined;

  return <LoginForm notice={notice} />;
}
