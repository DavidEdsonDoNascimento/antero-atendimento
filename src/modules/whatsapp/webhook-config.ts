// Lógica pura (sem I/O) — sem `import "server-only"`, testável com `node --test`.
// Quem lê `process.env` é a rota do webhook.

/**
 * Segredos do webhook da Meta (E2B-1), só de variáveis de ambiente do servidor:
 *
 *   WHATSAPP_APP_SECRET    App Secret do aplicativo na Meta: chave do HMAC
 *                          `X-Hub-Signature-256` de cada notificação.
 *   WHATSAPP_VERIFY_TOKEN  valor que você inventa e informa no painel da Meta
 *                          ao assinar o webhook (verificação GET).
 *
 * Sem os dois, o webhook responde 503 (a Meta tenta de novo) e o resto da
 * aplicação continua funcionando. Os valores nunca aparecem em erro ou log.
 */
export type WebhookConfig = { appSecret: string; verifyToken: string };

export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

// O App Secret da Meta é hexadecimal (32 caracteres); aceitamos a mesma família
// com folga. O verify token é escolhido por quem configura: caracteres seguros
// em URL, comprido o bastante para não ser adivinhado.
const APP_SECRET = /^[A-Za-z0-9]{16,128}$/;
const VERIFY_TOKEN = /^[A-Za-z0-9._~-]{24,256}$/;

/** Lê e valida a configuração. Lança `WebhookConfigError` sem nenhum valor. */
export function parseWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const appSecret = env.WHATSAPP_APP_SECRET?.trim() ?? "";
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  if (!appSecret) throw new WebhookConfigError("WHATSAPP_APP_SECRET é obrigatória para o webhook.");
  if (!APP_SECRET.test(appSecret)) {
    throw new WebhookConfigError("WHATSAPP_APP_SECRET deve ter de 16 a 128 caracteres alfanuméricos (o App Secret da Meta).");
  }
  if (!verifyToken) throw new WebhookConfigError("WHATSAPP_VERIFY_TOKEN é obrigatória para o webhook.");
  if (!VERIFY_TOKEN.test(verifyToken)) {
    throw new WebhookConfigError("WHATSAPP_VERIFY_TOKEN deve ter de 24 a 256 caracteres (letras, dígitos, . _ ~ -).");
  }
  if (appSecret === verifyToken) {
    throw new WebhookConfigError("WHATSAPP_VERIFY_TOKEN não pode ser igual ao WHATSAPP_APP_SECRET.");
  }
  return { appSecret, verifyToken };
}
