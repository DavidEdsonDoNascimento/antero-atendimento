// Lógica pura (sem I/O) — testável com `node --test`. Traduz as respostas
// do handler do Better Auth (`/api/auth/*`) para mensagens do produto. Nunca
// repassa o texto do servidor e nunca revela se um e-mail existe.

export type AuthFailure = { status: number; code?: string };

const TOO_MANY = "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
const UNAVAILABLE = "Serviço de autenticação indisponível. Tente novamente em instantes.";
const ORIGIN = "Não foi possível validar a requisição. Recarregue a página e tente novamente.";

function common(failure: AuthFailure): string | null {
  if (failure.status === 429) return TOO_MANY;
  if (failure.status === 403) return ORIGIN;
  if (failure.status === 0 || failure.status >= 500) return UNAVAILABLE;
  return null;
}

/** Login: credencial errada, e-mail inexistente e dados inválidos têm a MESMA mensagem. */
export function signInFailureMessage(failure: AuthFailure): string {
  return common(failure) ?? "E-mail ou senha inválidos.";
}

/** Pedido de redefinição: a resposta de sucesso já é neutra; aqui só limite e indisponibilidade. */
export function passwordResetRequestFailureMessage(failure: AuthFailure): string {
  return common(failure) ?? "Não foi possível enviar o link agora. Tente novamente.";
}

/** Troca da senha pelo token do e-mail. */
export function passwordResetFailureMessage(failure: AuthFailure): string {
  const shared = common(failure);
  if (shared) return shared;
  if (failure.code === "PASSWORD_TOO_SHORT") return "A senha deve ter ao menos 8 caracteres.";
  if (failure.code === "PASSWORD_TOO_LONG") return "A senha deve ter no máximo 128 caracteres.";
  return "Link de redefinição inválido ou expirado. Solicite um novo link.";
}

/** Aviso exibido no login conforme `?aviso=` (lista fechada; outros valores são ignorados). */
export function loginNotice(value: string | string[] | undefined): string | undefined {
  return value === "senha-redefinida" ? "Senha redefinida. Entre com a nova senha." : undefined;
}
