#!/usr/bin/env node
// Provisiona uma identidade fictícia LOCAL no Better Auth (sem cadastro
// público). Use via `pnpm auth:provision <test|dev> --email … --name …`:
// o scripts/infra.mjs monta o ambiente local (antero_auth no banco do alvo,
// origem localhost, segredo aleatório). Ver docs/AUTH.md.
//
//   --email <e-mail>       obrigatório (normalizado para minúsculas)
//   --name <nome>          obrigatório na criação
//   --rotate-password      se o e-mail já existe, define uma nova senha
//
// A senha (gerada) aparece UMA vez na saída e não é gravada em lugar nenhum.
// O script não vincula organizações nem concede administração da plataforma.

import { parseArgs } from "node:util";

import { parseIdentityConfig } from "../src/lib/identity/config.ts";
import { createIdentityPool } from "../src/lib/identity/pool.ts";
import { createLocalProvisioner } from "../src/lib/identity/provision.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    "rotate-password": { type: "boolean", default: false },
  },
});

if (!values.email) {
  console.error("[auth:provision] informe --email (e --name na criação).");
  process.exit(2);
}

const config = parseIdentityConfig(process.env);
const pool = createIdentityPool(config.database);
try {
  const provisioner = createLocalProvisioner({ config, pool });
  const result = await provisioner.provision({
    email: values.email,
    name: values.name ?? values.email.split("@")[0],
    rotatePassword: values["rotate-password"],
  });
  console.log(
    `[auth:provision] ${result.created ? "identidade criada" : "identidade já existia"}: ` +
      `${result.email} (id ${result.userId}, banco ${config.database.database}:${config.database.port})`,
  );
  if (result.password) {
    console.log(`[auth:provision] senha (anote agora; não é exibida de novo nem gravada): ${result.password}`);
  } else {
    console.log("[auth:provision] senha mantida (use --rotate-password para trocá-la).");
  }
} catch (error) {
  console.error(`[auth:provision] ${error instanceof Error ? `${error.name}: ${error.message}` : "falha"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
