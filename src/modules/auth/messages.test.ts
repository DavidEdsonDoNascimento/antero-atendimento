import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loginNotice,
  passwordResetFailureMessage,
  passwordResetRequestFailureMessage,
  signInFailureMessage,
} from "./messages.ts";

test("login: credencial errada e dados inválidos têm a mesma mensagem neutra", () => {
  const neutral = "E-mail ou senha inválidos.";
  assert.equal(signInFailureMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }), neutral);
  assert.equal(signInFailureMessage({ status: 400, code: "VALIDATION_ERROR" }), neutral);
});

test("login: limite, origem e indisponibilidade têm mensagens próprias", () => {
  assert.match(signInFailureMessage({ status: 429 }), /Muitas tentativas/);
  assert.match(signInFailureMessage({ status: 403, code: "INVALID_ORIGIN" }), /Recarregue a página/);
  assert.match(signInFailureMessage({ status: 503 }), /indisponível/);
  assert.match(signInFailureMessage({ status: 500 }), /indisponível/);
  assert.match(signInFailureMessage({ status: 0 }), /indisponível/);
});

test("recuperação e redefinição de senha", () => {
  assert.match(passwordResetRequestFailureMessage({ status: 429 }), /Muitas tentativas/);
  assert.match(passwordResetFailureMessage({ status: 400, code: "INVALID_TOKEN" }), /inválido ou expirado/);
  assert.match(passwordResetFailureMessage({ status: 400, code: "PASSWORD_TOO_SHORT" }), /ao menos 8/);
  assert.match(passwordResetFailureMessage({ status: 400, code: "PASSWORD_TOO_LONG" }), /no máximo 128/);
  assert.match(passwordResetFailureMessage({ status: 503 }), /indisponível/);
});

test("aviso do login: só valores conhecidos (texto da URL nunca é exibido)", () => {
  assert.match(loginNotice("senha-redefinida") ?? "", /Senha redefinida/);
  assert.equal(loginNotice("<script>"), undefined);
  assert.equal(loginNotice(["senha-redefinida"]), undefined);
  assert.equal(loginNotice(undefined), undefined);
});
