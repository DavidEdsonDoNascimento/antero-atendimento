import assert from "node:assert/strict";
import { test } from "node:test";

import { isSimulatorEnabled } from "../../lib/dev-environment.ts";
import { isSimulatedInboundId, normalizeSimulatorPhone } from "./phone.ts";

test("telefone: formatos comuns viram E.164", () => {
  assert.equal(normalizeSimulatorPhone("+55 (11) 91234-5678"), "+5511912345678");
  assert.equal(normalizeSimulatorPhone("0055 11 91234.5678"), "+5511912345678");
  assert.equal(normalizeSimulatorPhone("  +5511912345678 "), "+5511912345678");
});

test("telefone: sem código do país, com letras ou longo demais é recusado", () => {
  for (const raw of ["11912345678", "+55 11 9abc", "+0123456", "+1234567890123456", "", "+"]) {
    assert.equal(normalizeSimulatorPhone(raw), null, raw);
  }
});

test("id externo simulado: só o formato gerado pelo simulador", () => {
  assert.equal(isSimulatedInboundId("sim-in-2f1c9a5e-8b7d-4c3a-9e1f-0a1b2c3d4e5f"), true);
  for (const value of ["wamid.HBgM", "sim-in-", "sim-in-2F1C9A5E-8B7D-4C3A-9E1F-0A1B2C3D4E5F", null, 42]) {
    assert.equal(isSimulatedInboundId(value), false, String(value));
  }
});

test("simulador: habilitado só em development e test", () => {
  assert.equal(isSimulatorEnabled("development"), true);
  assert.equal(isSimulatorEnabled("test"), true);
  for (const env of ["production", "", "staging", "DEVELOPMENT"]) {
    assert.equal(isSimulatorEnabled(env), false, String(env));
  }
});
