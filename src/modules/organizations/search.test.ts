import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOLD_FROM,
  FOLD_TO,
  ORGANIZATION_SEARCH_MAX_LENGTH,
  foldSearchText,
  organizationSearchPattern,
  organizationsHref,
  parseOrganizationSearch,
  parseOrganizationStatusFilter,
} from "./search.ts";

test("o mapa de acentos tem um destino para cada letra", () => {
  assert.equal([...FOLD_FROM].length, FOLD_TO.length);
  assert.equal(foldSearchText("Clínica ÁÀÂÃÄ éèêë ÍÌÎÏ óòôõö ÚÙÛÜ Çç"), "clinica aaaaa eeee iiii ooooo uuuu cc");
});

test("termo da busca: aparado, em uma linha, com tamanho limitado; vazio não filtra", () => {
  assert.equal(parseOrganizationSearch("  Clínica   Aurora "), "Clínica Aurora");
  assert.equal(parseOrganizationSearch(["Boreal", "outro"]), "Boreal");
  for (const empty of [undefined, "", "   ", []]) assert.equal(parseOrganizationSearch(empty as string), undefined);
  assert.equal(parseOrganizationSearch("a".repeat(500))?.length, ORGANIZATION_SEARCH_MAX_LENGTH);
});

test("situação: só active e inactive; qualquer outro valor não filtra", () => {
  assert.equal(parseOrganizationStatusFilter("active"), "active");
  assert.equal(parseOrganizationStatusFilter("inactive"), "inactive");
  for (const value of ["", "ACTIVE", "suspensa", "active' OR 1=1 --", undefined]) {
    assert.equal(parseOrganizationStatusFilter(value), undefined, String(value));
  }
});

test("padrão LIKE: ignora acento e caixa e escapa curingas digitados", () => {
  assert.equal(organizationSearchPattern("Clínica"), "%clinica%");
  assert.equal(organizationSearchPattern("100%_x\\"), "%100\\%\\_x\\\\%");
});

test("endereço da lista guarda só os filtros ativos", () => {
  assert.equal(organizationsHref(), "/admin");
  assert.equal(organizationsHref({ status: "inactive" }), "/admin?situacao=inactive");
  assert.equal(organizationsHref({ search: "Clínica Aurora", status: "active" }), "/admin?busca=Cl%C3%ADnica+Aurora&situacao=active");
});
