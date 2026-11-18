import assert from "node:assert/strict";
import { test } from "node:test";

import { AUDIT_ACTIONS } from "./catalog.ts";
import {
  activityHref,
  hasActivityFilters,
  parseActivitySearchParams,
  parseAuditActionFilter,
  parseCalendarDate,
  parseOrganizationFilter,
} from "./search-params.ts";

const ORG = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";

test("tipo: só as quatro operações; qualquer outro valor não filtra", () => {
  for (const action of AUDIT_ACTIONS) assert.equal(parseAuditActionFilter(action), action);
  assert.equal(parseAuditActionFilter(["module.enabled", "x"]), "module.enabled");
  for (const value of [undefined, "", "MODULE.ENABLED", "support.started", "module.enabled' --", "todos"]) {
    assert.equal(parseAuditActionFilter(value), undefined, String(value));
  }
});

test("datas: só dias reais AAAA-MM-DD entre 2000 e 2100", () => {
  assert.equal(parseCalendarDate("2026-11-18"), "2026-11-18");
  assert.equal(parseCalendarDate(" 2024-02-29 "), "2024-02-29");
  assert.equal(parseCalendarDate(undefined), undefined);
  assert.equal(parseCalendarDate(""), undefined);
  for (const value of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "18/11/2026", "1999-12-31", "2101-01-01", "2026-11-18T00:00", "amanhã"]) {
    assert.equal(parseCalendarDate(value), null, value);
  }
});

test("organização: só UUID (normalizado em minúsculas)", () => {
  assert.equal(parseOrganizationFilter(ORG), ORG);
  assert.equal(parseOrganizationFilter(ORG.toUpperCase()), ORG);
  for (const value of [undefined, "", "nao-e-uuid", `${ORG}'`, "00000000-0000-0000-0000"]) {
    assert.equal(parseOrganizationFilter(value), undefined, String(value));
  }
});

test("parâmetros: filtros válidos, cursor opaco e organização só na visão global", () => {
  const sp = { tipo: "module.disabled", de: "2026-11-01", ate: "2026-11-18", organizacao: ORG, antes: "abc" };
  assert.deepEqual(parseActivitySearchParams(sp, { withOrganization: true }), {
    filters: { action: "module.disabled", from: "2026-11-01", to: "2026-11-18", organizationId: ORG },
    cursor: "abc",
    periodInvalid: false,
    periodInput: { from: "2026-11-01", to: "2026-11-18" },
  });
  assert.deepEqual(parseActivitySearchParams(sp, { withOrganization: false }).filters, {
    action: "module.disabled",
    from: "2026-11-01",
    to: "2026-11-18",
  });
  assert.deepEqual(parseActivitySearchParams({}, { withOrganization: true }), {
    filters: {},
    cursor: undefined,
    periodInvalid: false,
    periodInput: { from: undefined, to: undefined },
  });
  // Mesmo dia nas duas pontas é válido; só uma das pontas também.
  assert.equal(parseActivitySearchParams({ de: "2026-11-18", ate: "2026-11-18" }, { withOrganization: false }).periodInvalid, false);
  assert.deepEqual(parseActivitySearchParams({ ate: "2026-11-18" }, { withOrganization: false }).filters, { to: "2026-11-18" });
});

test("período inválido: aviso e só o período ignorado; os demais filtros continuam", () => {
  const reversed = parseActivitySearchParams(
    { tipo: "organization.suspended", de: "2026-11-18", ate: "2026-11-01", organizacao: ORG },
    { withOrganization: true },
  );
  assert.equal(reversed.periodInvalid, true);
  assert.deepEqual(reversed.filters, { action: "organization.suspended", organizationId: ORG });
  assert.deepEqual(reversed.periodInput, { from: "2026-11-18", to: "2026-11-01" });

  const malformed = parseActivitySearchParams({ tipo: "module.enabled", de: "2026-02-30", ate: "2026-11-01" }, { withOrganization: false });
  assert.equal(malformed.periodInvalid, true);
  assert.deepEqual(malformed.filters, { action: "module.enabled" });
  assert.deepEqual(malformed.periodInput, { from: undefined, to: "2026-11-01" });
});

test("filtros ativos: período e organização contam; cursor não", () => {
  assert.equal(hasActivityFilters({}), false);
  assert.equal(hasActivityFilters({ action: "module.enabled" }), true);
  assert.equal(hasActivityFilters({ to: "2026-11-18" }), true);
  assert.equal(hasActivityFilters({ organizationId: ORG }), true);
});

test("endereço: só o que foi informado, cursor no fim e só quando pedido", () => {
  assert.equal(activityHref("/admin/atividades"), "/admin/atividades");
  assert.equal(
    activityHref("/admin/atividades", { action: "module.enabled", from: "2026-11-01", to: "2026-11-18", organizationId: ORG }, "c1"),
    `/admin/atividades?tipo=module.enabled&de=2026-11-01&ate=2026-11-18&organizacao=${ORG}&antes=c1`,
  );
  assert.equal(activityHref(`/admin/organizacoes/${ORG}/atividades`, { to: "2026-11-18" }), `/admin/organizacoes/${ORG}/atividades?ate=2026-11-18`);
  // "Voltar aos mais recentes": mesmos filtros, sem cursor.
  assert.equal(activityHref("/admin/atividades", { action: "module.disabled" }), "/admin/atividades?tipo=module.disabled");
});
