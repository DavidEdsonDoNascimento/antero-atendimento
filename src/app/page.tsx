import { redirect } from "next/navigation";

export default function RootPage() {
  // O proxy já redireciona não autenticados para /login.
  redirect("/visao-geral");
}
