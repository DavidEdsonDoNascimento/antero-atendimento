import assert from "node:assert/strict";
import { test } from "node:test";

import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants.js";

import nextConfig from "../../next.config.ts";

test("páginas .dev.tsx (simulador) só são rotas no servidor de desenvolvimento", () => {
  assert.ok(nextConfig(PHASE_DEVELOPMENT_SERVER).pageExtensions?.includes("dev.tsx"));
  for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
    const extensions = nextConfig(phase).pageExtensions ?? [];
    assert.deepEqual(extensions, ["tsx", "ts", "jsx", "js"], phase);
    assert.ok(!extensions.some((extension) => extension.startsWith("dev.")), phase);
  }
});
