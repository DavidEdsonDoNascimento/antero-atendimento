import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { findViolations } from "../../scripts/check-no-supabase.mjs";

const scan = (path: string, content: string) => findViolations([{ path, content }]);

test("detecta usos operacionais do Supabase em arquivos ativos", () => {
  const bad = [
    'import { createClient } from "@supabase/supabase-js";',
    "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
    "const url = process.env.SUPABASE_SERVICE_ROLE_KEY;",
    'import { createServerClient } from "@/lib/supabase/server";',
    "$ supabase start",
    '"@supabase/ssr": "^0.12.3"',
  ];
  for (const line of bad) assert.ok(scan("src/x.ts", line).length > 0, line);
});

test("não falha por menções históricas nem por arquivos de histórico", () => {
  assert.deepEqual(scan("docs/AUTH.md", "O Supabase foi removido na Entrega 6; o histórico está no Git."), []);
  assert.deepEqual(scan("src/x.ts", "// substituiu as consultas PostgREST do Supabase"), []);
  assert.deepEqual(scan("claude-reports/latest.md", "@supabase/ssr e SUPABASE_URL (histórico)"), []);
  assert.deepEqual(scan("db/migrations/0001_init.sql", "-- porte de supabase/migrations/0001_init.sql"), []);
});

test("o repositório atual não tem dependências operacionais do Supabase", () => {
  const output = execFileSync(process.execPath, ["scripts/check-no-supabase.mjs"], { encoding: "utf8" });
  assert.match(output, /nenhuma dependência operacional/);
});
