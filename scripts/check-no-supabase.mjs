#!/usr/bin/env node
// Falha se o repositório voltar a ter qualquer dependência OPERACIONAL do
// Supabase (Entrega 6): pacotes, clientes, variáveis de ambiente, URLs, CLI,
// o diretório `supabase/` ou variáveis nos arquivos `.env*` locais.
//
// Não falha por menções históricas: relatórios (`claude-reports/`), os
// comentários das migrations portadas (`db/migrations`, `db/tests`) e o texto
// livre da documentação ("o Supabase foi removido…") não casam com os padrões
// abaixo, que descrevem usos reais (import, variável, URL, comando).
//
//   pnpm check:supabase

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FORBIDDEN = [
  [/@supabase\//, "pacote ou import @supabase/*"],
  [/\bsupabase-js\b/, "supabase-js"],
  [/\bSUPABASE_[A-Z_]+/, "variável SUPABASE_*"],
  [/NEXT_PUBLIC_SUPABASE/, "variável NEXT_PUBLIC_SUPABASE_*"],
  [/\.supabase\.(?:co|com|in)\b/, "URL do Supabase"],
  [/lib\/supabase\b/, "módulo lib/supabase"],
  [/\bsupabase\s+(?:start|stop|db|link|gen|init|login|status|migration)\b/i, "comando da CLI do Supabase"],
  [/\bcreate(?:Server|Browser)Client\b/, "cliente do @supabase/ssr"],
];

// Arquivos que descrevem o histórico ou a própria verificação.
const SKIP = [/^claude-reports\//, /^db\/migrations\//, /^db\/tests\//, /^\.claude\//, /^scripts\/check-no-supabase\.mjs$/, /^eslint\.config\.mjs$/, /^src\/lib\/no-supabase\.test\.ts$/];

/** @param {{ path: string, content: string }[]} files */
export function findViolations(files) {
  const violations = [];
  for (const { path, content } of files) {
    if (SKIP.some((pattern) => pattern.test(path))) continue;
    content.split("\n").forEach((line, index) => {
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${path}:${index + 1}: ${label}`);
      }
    });
  }
  return violations;
}

function repositoryFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  if (listed.status !== 0) throw new Error("git ls-files falhou");
  return listed.stdout
    .split("\0")
    .filter((path) => path && existsSync(join(ROOT, path)))
    .filter((path) => !/\.(?:woff2?|ico|png|jpe?g|webp)$/.test(path))
    .map((path) => ({ path, content: readFileSync(join(ROOT, path), "utf8") }));
}

/** Estrutura: o diretório supabase/ não pode existir e `.env*` locais não podem declarar variáveis SUPABASE_*. */
export function structuralProblems(root = ROOT) {
  const problems = [];
  if (existsSync(join(root, "supabase"))) problems.push("o diretório supabase/ existe (removido na Entrega 6)");
  for (const name of readdirSync(root).filter((entry) => entry.startsWith(".env"))) {
    // Só os NOMES das variáveis são lidos; valores nunca são impressos.
    const names = readFileSync(join(root, name), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")[0]);
    if (names.some((variable) => /SUPABASE/i.test(variable))) {
      problems.push(`${name} declara variáveis do Supabase (o Next.js as carregaria)`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = [...structuralProblems(), ...findViolations(repositoryFiles())];
  if (problems.length > 0) {
    console.error(`[check:supabase] ${problems.length} referência(s) operacional(is) ao Supabase:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("[check:supabase] nenhuma dependência operacional do Supabase.");
}
