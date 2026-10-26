#!/usr/bin/env node
// Confere o schema `auth` contra a configuração versionada do Better Auth.
//
// Use via `pnpm db:test:auth-schema` / `pnpm db:auth-schema` (o
// scripts/infra.mjs monta a URL com a credencial do antero_auth a partir de
// .env.infra). Nunca executa migrations: só lê o catálogo.
//
//   check  (padrão) falha se o planejador oficial do Better Auth
//          (`getMigrations`, o mesmo que `auth generate`/`auth migrate` usam)
//          quiser criar/alterar qualquer coisa, emitir qualquer aviso de
//          divergência, ou se os tipos/nulabilidade/FKs/unicidade não forem
//          exatamente os esperados (ids e referências em `uuid`).
//   print  imprime o SQL que o gerador oficial produziria para este banco
//          (num banco sem o schema `auth`, é o schema completo de referência).

import { PostgresDialect } from "kysely";
import pg from "pg";
import { getAuthTables } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";

import {
  BETTER_AUTH_DB_SCHEMA,
  betterAuthSchemaOptions,
} from "../src/lib/auth/better-auth-options.ts";

const mode = process.argv[2] ?? "check";
const connectionString = process.env.AUTH_SCHEMA_DATABASE_URL;
if (!connectionString) {
  console.error("[auth-schema] AUTH_SCHEMA_DATABASE_URL ausente — use `pnpm db:test:auth-schema`.");
  process.exit(2);
}
if (!/@(127\.0\.0\.1|localhost):\d+\//.test(connectionString)) {
  console.error("[auth-schema] recusado: só bancos locais.");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 2 });
const warnings = [];
const options = {
  ...betterAuthSchemaOptions,
  database: {
    dialect: new PostgresDialect({ pool }),
    type: "postgres",
    schemaName: BETTER_AUTH_DB_SCHEMA,
  },
  logger: {
    level: "warn",
    log: (level, message) => {
      if (level === "warn" || level === "error") warnings.push(message);
    },
  },
  telemetry: { enabled: false },
};

const problems = [];
const ok = (label, condition, detail = "") => {
  console.log(`  ${condition ? "ok  " : "FALHA"} ${label}`);
  if (!condition) problems.push(detail ? `${label}: ${detail}` : label);
};

try {
  const plan = await getMigrations(options, { throwOnUnsafe: false });

  if (mode === "print") {
    const sql = await plan.compileMigrations();
    console.log(sql === ";" ? "-- nada a gerar: o schema já corresponde à configuração" : sql);
  } else {
    console.log(`[auth-schema] Better Auth: schema "${BETTER_AUTH_DB_SCHEMA}"`);
    ok("planejador oficial: nenhuma tabela a criar", plan.toBeCreated.length === 0, plan.toBeCreated.map((t) => t.table).join(", "));
    ok(
      "planejador oficial: nenhuma coluna a acrescentar",
      plan.toBeAdded.length === 0,
      plan.toBeAdded.map((t) => `${t.table}(${Object.keys(t.fields).join(", ")})`).join("; "),
    );
    ok("planejador oficial: nenhum índice a criar", plan.toBeAddedIndexes.length === 0, plan.toBeAddedIndexes.map((i) => i.name).join(", "));
    ok("planejador oficial: nenhuma coluna obrigatória inesperada", plan.schemaProblems.length === 0, plan.schemaProblems.join("; "));
    ok("planejador oficial: nenhuma mudança insegura", plan.unsafeChanges.length === 0, plan.unsafeChanges.join("; "));
    ok("planejador oficial: nenhum aviso de tipo/nulabilidade", warnings.length === 0, warnings.join("; "));

    // Verificação estrita (o planejador aceita `text` onde esperamos `uuid`).
    const { rows: columns } = await pool.query(
      `select table_name, column_name, data_type, is_nullable
         from information_schema.columns where table_schema = $1`,
      [BETTER_AUTH_DB_SCHEMA],
    );
    const { rows: fks } = await pool.query(
      `select src.relname as table_name, a.attname as column_name, dst.relname as ref_table,
              ns.nspname as ref_schema, c.confdeltype
         from pg_constraint c
         join pg_class src on src.oid = c.conrelid
         join pg_class dst on dst.oid = c.confrelid
         join pg_namespace ns on ns.oid = dst.relnamespace
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and src.relnamespace = $1::regnamespace`,
      [BETTER_AUTH_DB_SCHEMA],
    );
    const { rows: uniques } = await pool.query(
      `select t.relname as table_name, a.attname as column_name
         from pg_index i
         join pg_class t on t.oid = i.indrelid
         join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
        where i.indisunique and i.indnatts = 1 and not i.indisprimary
          and t.relnamespace = $1::regnamespace`,
      [BETTER_AUTH_DB_SCHEMA],
    );

    const sqlType = { string: "text", boolean: "boolean", date: "timestamp with time zone", number: "integer" };
    const tables = getAuthTables(betterAuthSchemaOptions);
    const expectedColumns = new Set();
    for (const table of Object.values(tables)) {
      const name = table.modelName;
      const id = columns.find((c) => c.table_name === name && c.column_name === "id");
      ok(`${name}.id é uuid not null`, id?.data_type === "uuid" && id?.is_nullable === "NO", JSON.stringify(id));
      expectedColumns.add(`${name}.id`);
      for (const [key, field] of Object.entries(table.fields)) {
        const column = field.fieldName ?? key;
        expectedColumns.add(`${name}.${column}`);
        const actual = columns.find((c) => c.table_name === name && c.column_name === column);
        const type = field.references?.field === "id" ? "uuid" : (sqlType[field.type] ?? "?");
        const nullable = field.required === false ? "YES" : "NO";
        ok(
          `${name}.${column}: ${type}${nullable === "NO" ? " not null" : ""}`,
          actual?.data_type === type && actual?.is_nullable === nullable,
          JSON.stringify(actual),
        );
        if (field.references) {
          const fk = fks.find((f) => f.table_name === name && f.column_name === column);
          const target = tables[field.references.model]?.modelName;
          ok(
            `${name}.${column} → ${BETTER_AUTH_DB_SCHEMA}.${target}(id) on delete ${field.references.onDelete}`,
            fk?.ref_table === target && fk?.ref_schema === BETTER_AUTH_DB_SCHEMA && fk?.confdeltype === "c",
            JSON.stringify(fk),
          );
        }
        if (field.unique) {
          ok(`${name}.${column} é único`, uniques.some((u) => u.table_name === name && u.column_name === column));
        }
      }
    }
    const extra = columns.filter((c) => !expectedColumns.has(`${c.table_name}.${c.column_name}`));
    ok("nenhuma coluna fora da configuração", extra.length === 0, extra.map((c) => `${c.table_name}.${c.column_name}`).join(", "));
    const extraTables = [...new Set(columns.map((c) => c.table_name))].filter(
      (t) => !Object.values(tables).some((table) => table.modelName === t),
    );
    ok("nenhuma tabela fora da configuração", extraTables.length === 0, extraTables.join(", "));

    if (problems.length > 0) {
      console.error(`[auth-schema] ${problems.length} divergência(s):\n  - ${problems.join("\n  - ")}`);
      process.exitCode = 1;
    } else {
      console.log("[auth-schema] schema corresponde à configuração do Better Auth.");
    }
  }
} finally {
  await pool.end();
}
