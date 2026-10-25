import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogApi, CatalogApiError } from "../apps/geolibre-desktop/src/lib/catalog-api";

test("catalog client sends same-origin dataset search and reads paged results", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = createCatalogApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ items: [], limit: 25, offset: 0, has_more: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const page = await api.listDatasets({ query: "roads", format: "gpkg", limit: 25 });
  assert.equal(page.has_more, false);
  assert.equal(calls[0]?.url, "/api/catalog/datasets?q=roads&format=gpkg&limit=25");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
});

test("catalog client surfaces API status and server error", async () => {
  const api = createCatalogApi({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "dataset bucket is not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    api.getReadUrl("dataset-1"),
    (error: unknown) =>
      error instanceof CatalogApiError &&
      error.status === 403 &&
      error.message === "dataset bucket is not allowed",
  );
});
