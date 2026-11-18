import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAuditEventsQuery } from "./sql.ts";

const ORG = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";
const CURSOR = { occurredAt: "2026-03-10T12:00:00.000001+00:00", id: "42" };

const compact = (text: string) => text.replace(/\s+/g, " ").trim();

test("sem filtros: página global ordenada por (occurred_at, id) desc, limit + 1, sem OFFSET", () => {
  const query = buildAuditEventsQuery({}, { cursor: null, limit: 25 });
  const text = compact(query.text);
  assert.deepEqual(query.values, [26]);
  assert.doesNotMatch(text, /WHERE/);
  assert.match(text, /LIMIT \$1::int/);
  assert.match(text, /ORDER BY a\.occurred_at DESC, a\.id DESC LIMIT/);
  assert.match(text, /\) e LEFT JOIN public\.organizations o ON o\.id = e\.organization_id LEFT JOIN public\.profiles p ON p\.id = e\.actor_user_id ORDER BY e\.occurred_at DESC, e\.id DESC$/);
  assert.doesNotMatch(text, /OFFSET/i);
});

test("só os campos necessários: nada de details inteiro, db_role nem e-mail", () => {
  const text = compact(buildAuditEventsQuery({}, { cursor: null, limit: 25 }).text);
  const outer = text.slice(0, text.indexOf(" FROM ("));
  assert.match(outer, /e\.details ->> 'module' AS module, e\.details ->> 'from' AS from_state, e\.details ->> 'to' AS to_state/);
  assert.doesNotMatch(outer, /e\.details(?! ->>)/);
  assert.doesNotMatch(text, /db_role|email|\*/);
});

test("todos os filtros e o cursor: parâmetros numerados na ordem, nenhum valor no texto", () => {
  const query = buildAuditEventsQuery(
    { organizationId: ORG, action: "module.enabled", from: "2026-11-01", to: "2026-11-18" },
    { cursor: CURSOR, limit: 25 },
  );
  const text = compact(query.text);
  assert.deepEqual(query.values, [ORG, "module.enabled", "2026-11-01", "2026-11-18", CURSOR.occurredAt, CURSOR.id, 26]);
  assert.match(
    text,
    new RegExp(
      [
        "WHERE a\\.organization_id = \\$1::uuid",
        "AND a\\.action = \\$2::text",
        "AND a\\.occurred_at >= \\(\\$3::date::timestamp AT TIME ZONE 'America/Sao_Paulo'\\)",
        "AND a\\.occurred_at < \\(\\(\\$4::date \\+ 1\\)::timestamp AT TIME ZONE 'America/Sao_Paulo'\\)",
        "AND \\(a\\.occurred_at, a\\.id\\) < \\(\\$5::timestamptz, \\$6::bigint\\)",
        "ORDER BY",
      ].join(" "),
    ),
  );
  for (const value of [ORG, "module.enabled", "2026-11-01", "2026-11-18", CURSOR.occurredAt]) {
    assert.ok(!text.includes(value), `valor fora do texto: ${value}`);
  }
});

test("filtros isolados: cada um só acrescenta a própria condição", () => {
  const cases: Array<[Parameters<typeof buildAuditEventsQuery>[0], RegExp, unknown[]]> = [
    [{ organizationId: ORG }, /WHERE a\.organization_id = \$1::uuid ORDER BY/, [ORG, 26]],
    [{ action: "organization.suspended" }, /WHERE a\.action = \$1::text ORDER BY/, ["organization.suspended", 26]],
    [{ from: "2026-11-01" }, /WHERE a\.occurred_at >= \(\$1::date::timestamp AT TIME ZONE 'America\/Sao_Paulo'\) ORDER BY/, ["2026-11-01", 26]],
    [{ to: "2026-11-18" }, /WHERE a\.occurred_at < \(\(\$1::date \+ 1\)::timestamp AT TIME ZONE 'America\/Sao_Paulo'\) ORDER BY/, ["2026-11-18", 26]],
  ];
  for (const [filters, pattern, values] of cases) {
    const query = buildAuditEventsQuery(filters, { cursor: null, limit: 25 });
    assert.match(compact(query.text), pattern);
    assert.deepEqual(query.values, values);
  }
  const onlyCursor = buildAuditEventsQuery({}, { cursor: CURSOR, limit: 10 });
  assert.match(compact(onlyCursor.text), /WHERE \(a\.occurred_at, a\.id\) < \(\$1::timestamptz, \$2::bigint\) ORDER BY/);
  assert.deepEqual(onlyCursor.values, [CURSOR.occurredAt, CURSOR.id, 11]);
});
