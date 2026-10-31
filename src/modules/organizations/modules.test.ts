import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { OrganizationModule } from "../../lib/types/database";
import {
  MODULE_CATALOG,
  ORGANIZATION_MODULES,
  dependentsOf,
  filterByModules,
  isModuleChangeBlocked,
  isOrganizationModule,
  moduleBlockReason,
} from "./modules.ts";

const PAGES = join(process.cwd(), "src", "app", "(platform)");

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

test("o catálogo tem os quatro módulos, cada um com nome e descrição", () => {
  assert.deepEqual([...ORGANIZATION_MODULES], ["atendimento", "automacoes", "campanhas", "contatos"]);
  for (const name of ORGANIZATION_MODULES) {
    assert.ok(MODULE_CATALOG[name].label);
    assert.ok(MODULE_CATALOG[name].description);
  }
});

test("isOrganizationModule aceita só valores do catálogo", () => {
  assert.equal(isOrganizationModule("contatos"), true);
  for (const value of ["financeiro", "", null, undefined, ["contatos"], "ATENDIMENTO"]) {
    assert.equal(isOrganizationModule(value), false, String(value));
  }
});

test("dependências: Campanhas exige Contatos; Automações e Atendimento são independentes", () => {
  assert.deepEqual(MODULE_CATALOG.campanhas.requires, ["contatos"]);
  assert.deepEqual(dependentsOf("contatos"), ["campanhas"]);
  assert.deepEqual(MODULE_CATALOG.automacoes.requires, []);
  assert.deepEqual(MODULE_CATALOG.atendimento.requires, []);
  assert.deepEqual(dependentsOf("atendimento"), []);
  assert.deepEqual(dependentsOf("automacoes"), []);
});

test("isModuleChangeBlocked: orienta a tela conforme o estado atual", () => {
  assert.equal(isModuleChangeBlocked("campanhas", true, []), true);
  assert.equal(isModuleChangeBlocked("campanhas", true, ["contatos"]), false);
  assert.equal(isModuleChangeBlocked("contatos", false, ["contatos", "campanhas"]), true);
  assert.equal(isModuleChangeBlocked("contatos", false, ["contatos"]), false);
  assert.equal(isModuleChangeBlocked("campanhas", false, ["contatos", "campanhas"]), false);
  assert.equal(isModuleChangeBlocked("automacoes", true, []), false);
  assert.equal(isModuleChangeBlocked("atendimento", false, ["atendimento"]), false);
});

test("moduleBlockReason explica o que fazer", () => {
  assert.equal(moduleBlockReason("campanhas", true), "Habilite Contatos antes de habilitar Campanhas.");
  assert.equal(moduleBlockReason("contatos", false), "Desabilite Campanhas antes de desabilitar Contatos.");
});

test("filterByModules: mantém o núcleo e só os módulos habilitados", () => {
  const items: { id: string; module?: OrganizationModule }[] = [
    { id: "core" },
    { id: "a", module: "atendimento" },
    { id: "c", module: "campanhas" },
  ];
  assert.deepEqual(filterByModules(items, []).map((item) => item.id), ["core"]);
  assert.deepEqual(filterByModules(items, ["campanhas"]).map((item) => item.id), ["core", "c"]);
  assert.deepEqual(filterByModules(items, ["atendimento", "campanhas"]).map((item) => item.id), ["core", "a", "c"]);
});

test("toda página de rota de módulo chama requireModule com o módulo certo", () => {
  for (const name of ORGANIZATION_MODULES) {
    for (const route of MODULE_CATALOG[name].routes) {
      const dir = join(PAGES, route);
      assert.ok(existsSync(dir), `${route} existe`);
      const pages = pagesUnder(dir);
      assert.ok(pages.length > 0, `${route} tem página`);
      for (const page of pages) {
        assert.ok(readFileSync(page, "utf8").includes(`requireModule("${name}")`), `${page} exige ${name}`);
      }
    }
  }
});

test("nav-config declara o módulo de cada rota do catálogo", () => {
  const nav = readFileSync(join(process.cwd(), "src", "components", "layout", "nav-config.tsx"), "utf8");
  for (const name of ORGANIZATION_MODULES) {
    for (const route of MODULE_CATALOG[name].routes) {
      assert.match(nav, new RegExp(`href: "${route}".*module: "${name}"`), route);
    }
  }
});

test("as consultas da Inbox exigem o módulo na transação", () => {
  const source = readFileSync(join(process.cwd(), "src", "modules", "conversations", "sql-queries.ts"), "utf8");
  assert.match(source, /withModuleTransaction\(context, "atendimento", work\)/);
  assert.doesNotMatch(source, /withOrganizationTransaction/);
});

test("nenhuma regra específica de cliente no código de módulos", () => {
  const files = [
    "src/modules/organizations/modules.ts",
    "src/modules/organizations/sql-queries.ts",
    "src/modules/organizations/actions.ts",
    "src/lib/auth/dal.ts",
    "db/migrations/0007_organization_modules.sql",
  ];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), file), "utf8"), /invernada|simone|saint.?honor/i, file);
  }
});
