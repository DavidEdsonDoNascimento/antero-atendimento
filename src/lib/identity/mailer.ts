import "server-only";

import nodemailer from "nodemailer";

import type { IdentityConfig } from "./config";

/**
 * Envio dos e-mails de autenticação (hoje: redefinição de senha) por SMTP —
 * Mailpit no ambiente local; o provedor de produção entra pela mesma
 * configuração (`SMTP_*`, com TLS exigido em produção).
 *
 * Nada aqui registra o destinatário, o link ou o token.
 */

export type PasswordResetMessage = {
  to: string;
  name: string;
  url: string;
};

export type IdentityMailer = {
  sendPasswordReset(message: PasswordResetMessage): Promise<void>;
  close(): void;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Assunto e corpo (texto + HTML) do e-mail de redefinição, em pt-BR. */
export function renderPasswordResetEmail({ name, url }: Omit<PasswordResetMessage, "to">) {
  const greeting = name.trim() ? `Olá, ${name.trim()}!` : "Olá!";
  const subject = "Redefinição de senha — Antero Atendimento";
  const text = [
    greeting,
    "",
    "Recebemos um pedido para redefinir a senha da sua conta no Antero Atendimento.",
    "Para escolher uma nova senha, acesse o link abaixo (válido por 1 hora e por um único uso):",
    "",
    url,
    "",
    "Se você não fez este pedido, ignore este e-mail: sua senha atual continua válida.",
  ].join("\n");
  const html = `<p>${escapeHtml(greeting)}</p>
<p>Recebemos um pedido para redefinir a senha da sua conta no Antero Atendimento.</p>
<p><a href="${escapeHtml(url)}">Escolher uma nova senha</a> (link válido por 1 hora e por um único uso).</p>
<p>Se você não fez este pedido, ignore este e-mail: sua senha atual continua válida.</p>`;
  return { subject, text, html };
}

export function createSmtpMailer(mail: IdentityConfig["mail"]): IdentityMailer {
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    requireTLS: mail.requireTLS,
    auth: mail.auth ?? undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });
  return {
    async sendPasswordReset({ to, name, url }) {
      await transport.sendMail({ from: mail.from, to, ...renderPasswordResetEmail({ name, url }) });
    },
    close() {
      transport.close();
    },
  };
}
