import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIdentityConfig } from "./config.ts";
import { IdentityConfigError } from "./errors.ts";
import { redactLogMessage } from "./options.ts";

const SECRET = "k9Q2x7Lm4Vt8Rz1Wp6Hs3Nb5Yc0Df2Gj";
const PASSWORD = "senha-do-banco-nao-pode-vazar";

const base = {
  AUTH_DATABASE_URL: `postgres://antero_auth:${PASSWORD}@127.0.0.1:55434/antero_atendimentos_test`,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000/",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "55425",
  MAIL_FROM: "Antero Atendimento <nao-responda@antero.local>",
};

/** Erro de configuração cuja mensagem não vaza senha nem segredo. */
function rejects(env: Record<string, string | undefined>, pattern: RegExp) {
  assert.throws(
    () => parseIdentityConfig(env),
    (error) =>
      error instanceof IdentityConfigError &&
      pattern.test(error.message) &&
      !error.message.includes(PASSWORD) &&
      !error.message.includes(SECRET),
  );
}

test("configuração local válida: origem sem barra, cookies sem Secure, limites padrão", () => {
  const config = parseIdentityConfig(base);
  assert.equal(config.baseURL, "http://localhost:3000");
  assert.equal(config.secureCookies, false);
  assert.deepEqual(
    [config.database.host, config.database.port, config.database.database, config.database.poolMax],
    ["127.0.0.1", 55434, "antero_atendimentos_test", 5],
  );
  assert.equal(config.database.statementTimeoutMs, 10_000);
  assert.deepEqual(config.mail, {
    host: "127.0.0.1",
    port: 55425,
    secure: false,
    requireTLS: false,
    auth: null,
    from: base.MAIL_FROM,
  });
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.production, false);
});

test("AUTH_DATABASE_URL: só antero_auth, com senha, sem parâmetros perigosos", () => {
  rejects({ ...base, AUTH_DATABASE_URL: undefined }, /AUTH_DATABASE_URL é obrigatória/);
  rejects({ ...base, AUTH_DATABASE_URL: base.AUTH_DATABASE_URL.replace("antero_auth", "antero_app") }, /antero_auth/);
  rejects({ ...base, AUTH_DATABASE_URL: base.AUTH_DATABASE_URL.replace("antero_auth", "antero_admin") }, /antero_auth/);
  rejects({ ...base, AUTH_DATABASE_URL: "postgres://antero_auth@127.0.0.1:5432/db" }, /senha/);
  rejects({ ...base, AUTH_DATABASE_URL: `${base.AUTH_DATABASE_URL}?options=-c%20role%3Dantero_owner` }, /options/);
  rejects({ ...base, AUTH_DATABASE_URL: `mysql://antero_auth:${PASSWORD}@h/db` }, /postgres/);
  rejects({ ...base, AUTH_DATABASE_POOL_MAX: "500" }, /no máximo 20/);
});

test("BETTER_AUTH_SECRET: obrigatório, longo e não trivial (sem ecoar o valor)", () => {
  rejects({ ...base, BETTER_AUTH_SECRET: undefined }, /BETTER_AUTH_SECRET é obrigatória/);
  rejects({ ...base, BETTER_AUTH_SECRET: "curto-demais" }, /32 caracteres/);
  rejects({ ...base, BETTER_AUTH_SECRET: "better-auth-secret-123456789012345678" }, /exemplo/);
  rejects({ ...base, BETTER_AUTH_SECRET: "a".repeat(40) }, /exemplo/);
  rejects({ ...base, BETTER_AUTH_SECRET: "abababababababababababababababababab" }, /exemplo/);
});

test("BETTER_AUTH_URL: https, ou http só em loopback fora de produção; só a origem", () => {
  rejects({ ...base, BETTER_AUTH_URL: "http://atendimento.exemplo.com" }, /https/);
  rejects({ ...base, BETTER_AUTH_URL: "ftp://localhost" }, /http/);
  rejects({ ...base, BETTER_AUTH_URL: "https://user:pass@atendimento.exemplo.com" }, /credenciais/);
  rejects({ ...base, BETTER_AUTH_URL: "https://atendimento.exemplo.com/app" }, /origem/);
  rejects({ ...base, BETTER_AUTH_URL: "https://atendimento.exemplo.com/?x=1" }, /origem/);
  rejects(
    { ...base, NODE_ENV: "production", AUTH_TRUSTED_PROXIES: "10.0.0.0/8" },
    /https/,
  );
  const secure = parseIdentityConfig({ ...base, BETTER_AUTH_URL: "https://atendimento.exemplo.com" });
  assert.equal(secure.secureCookies, true);
  assert.equal(secure.baseURL, "https://atendimento.exemplo.com");
});

test("produção exige proxy confiável (rate limit por IP) e TLS no SMTP", () => {
  const production = { ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://atendimento.exemplo.com" };
  rejects(production, /AUTH_TRUSTED_PROXIES é obrigatória/);
  const config = parseIdentityConfig({ ...production, AUTH_TRUSTED_PROXIES: "10.0.0.0/8, 172.16.0.1" });
  assert.deepEqual(config.trustedProxies, ["10.0.0.0/8", "172.16.0.1"]);
  assert.equal(config.mail.requireTLS, true);
  assert.equal(parseIdentityConfig({ ...production, AUTH_TRUSTED_PROXIES: "::1/128", SMTP_SECURE: "true" }).mail.requireTLS, false);
});

test("AUTH_TRUSTED_PROXIES inválido é recusado", () => {
  for (const value of ["10.0.0.0/33", "abc", "10.0.0.1/8/1", "::1/129"]) {
    rejects({ ...base, AUTH_TRUSTED_PROXIES: value }, /AUTH_TRUSTED_PROXIES/);
  }
});

test("SMTP: usuário e senha juntos; remetente com endereço", () => {
  rejects({ ...base, SMTP_USER: "usuario" }, /juntas/);
  rejects({ ...base, MAIL_FROM: "Antero sem endereco" }, /MAIL_FROM/);
  rejects({ ...base, SMTP_HOST: "" }, /SMTP_HOST/);
  rejects({ ...base, SMTP_SECURE: "sim" }, /SMTP_SECURE/);
  const config = parseIdentityConfig({ ...base, SMTP_USER: "usuario", SMTP_PASSWORD: "x", MAIL_FROM: "a@b.c" });
  assert.deepEqual(config.mail.auth, { user: "usuario", pass: "x" });
});

test("redactLogMessage remove tokens, callbacks e e-mails", () => {
  const cases: [string, string][] = [
    ["Invalid callbackURL: https://atacante.exemplo/x", "Invalid callbackURL: [redigido]"],
    ["GET /api/auth/reset-password/AbC123xyz?callbackURL=%2Fx", "GET /api/auth/reset-password/[redigido]?callbackURL=[redigido]"],
    ["redirect /redefinir-senha?token=AbC123", "redirect /redefinir-senha?token=[redigido]"],
    ["Sign-up attempt for existing email: maria@exemplo.com", "Sign-up attempt for existing email: [e-mail]"],
    ["User not found", "User not found"],
  ];
  for (const [input, expected] of cases) assert.equal(redactLogMessage(input), expected);
});
