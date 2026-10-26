import type { Metadata } from "next";

import { redirectIfAuthenticated } from "@/lib/auth/dal";
import { loginNotice } from "@/modules/auth/messages";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await redirectIfAuthenticated();
  const params = await searchParams;

  return <LoginForm notice={loginNotice(params.aviso)} />;
}
