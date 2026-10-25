/** Catalog-first browser for a managed private-data deployment. */

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { pluginDisplayTitle } from "../plugin-i18n";
import { addRasterToMap } from "./maplibre-raster";
import { addVectorLayerFromUrl } from "./maplibre-vector";

export const CATALOG_BROWSER_PLUGIN_ID = "geolibre-catalog-browser";

type Dataset = {
  id: string;
  display_name: string;
  format: string;
  description: string;
  current_revision_id: string | null;
};

type Page = { items: Dataset[]; has_more: boolean };
type Detail = Dataset & { revisions: Array<{ id: string; status: string }> };
type ReadAccess = { url: string };

const CSS = {
  root: "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  row: "display:flex;gap:4px;align-items:center;",
  input: "flex:1;min-width:0;padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  button: "padding:5px 9px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  list: "display:flex;flex-direction:column;gap:5px;overflow:auto;flex:1;min-height:0;",
  card: "display:flex;flex-direction:column;gap:4px;padding:7px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--muted));",
  title: "font-weight:600;word-break:break-word;",
  detail: "font-size:11px;color:hsl(var(--muted-foreground));",
  error: "font-size:11px;color:hsl(var(--destructive));white-space:pre-line;",
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text = "") {
  const value = document.createElement(tag);
  value.style.cssText = style;
  value.textContent = text;
  return value;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/catalog${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `Catalog request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status fallback for non-JSON responses.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function formatBytes(value: number | undefined): string {
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function buildPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  const root = node("div", CSS.root);
  const searchRow = node("div", CSS.row);
  const input = node("input", CSS.input) as HTMLInputElement;
  input.placeholder = "Search catalog datasets";
  const search = node("button", CSS.button, "Search") as HTMLButtonElement;
  search.type = "button";
  searchRow.append(input, search);
  const status = node("div", CSS.detail);
  const list = node("div", CSS.list);
  root.append(searchRow, status, list);
  container.append(root);

  let offset = 0;
  let loading = false;
  let disposed = false;

  async function load(reset = true): Promise<void> {
    if (loading || disposed) return;
    loading = true;
    if (reset) {
      offset = 0;
      list.replaceChildren();
    }
    status.textContent = "Loading…";
    try {
      const page = await api<Page>(`/datasets?q=${encodeURIComponent(input.value.trim())}&limit=50&offset=${offset}`);
      if (disposed) return;
      for (const dataset of page.items) list.append(renderDataset(dataset));
      offset += page.items.length;
      status.textContent = page.items.length === 0 && offset === page.items.length ? "No datasets found." : "";
      if (page.has_more) {
        const more = node("button", CSS.button, "Load more") as HTMLButtonElement;
        more.type = "button";
        more.addEventListener("click", () => {
          more.remove();
          void load(false);
        });
        list.append(more);
      }
    } catch (error) {
      status.className = "";
      status.style.cssText = CSS.error;
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function renderDataset(dataset: Dataset): HTMLElement {
    const card = node("div", CSS.card);
    card.append(node("div", CSS.title, dataset.display_name));
    card.append(node("div", CSS.detail, `${dataset.format}${dataset.description ? ` · ${dataset.description}` : ""}`));
    const add = node("button", CSS.button, "Add to map") as HTMLButtonElement;
    add.type = "button";
    add.addEventListener("click", () => void addDataset(dataset, add));
    card.append(add);
    return card;
  }

  async function addDataset(dataset: Dataset, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = "Opening…";
    try {
      const [detail, access] = await Promise.all([
        api<Detail>(`/datasets/${encodeURIComponent(dataset.id)}`),
        api<ReadAccess>(`/datasets/${encodeURIComponent(dataset.id)}/read-url`),
      ]);
      const revision = detail.revisions.find((candidate) => candidate.id === detail.current_revision_id);
      if (!revision || revision.status !== "complete") throw new Error("The current revision is unavailable.");
      if (["tif", "tiff", "cog", "geotiff"].includes(dataset.format.toLowerCase())) {
        await addRasterToMap(app, access.url, { name: dataset.display_name });
      } else {
        const added = await addVectorLayerFromUrl(app, access.url, { name: dataset.display_name });
        if (!added) throw new Error("This dataset could not be added to the map.");
      }
      button.textContent = "Added";
    } catch (error) {
      button.disabled = false;
      button.textContent = error instanceof Error ? error.message : "Add failed";
    }
  }

  search.addEventListener("click", () => void load());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void load();
  });
  void load();
  return () => {
    disposed = true;
    root.remove();
  };
}

export const maplibreCatalogBrowserPlugin: GeoLibrePlugin = {
  id: CATALOG_BROWSER_PLUGIN_ID,
  name: "Data Catalog",
  version: "0.1.0",
  engines: ["maplibre", "cesium", "mapbox", "arcgis"],
  sessionScoped: true,
  activate(app) {
    const unregister = app.registerRightPanel?.({
      id: CATALOG_BROWSER_PLUGIN_ID,
      title: pluginDisplayTitle(app, CATALOG_BROWSER_PLUGIN_ID, "Data Catalog"),
      dock: "replace-style",
      defaultWidth: 360,
      render: (container) => buildPanel(container, app),
    });
    app.openRightPanel?.(CATALOG_BROWSER_PLUGIN_ID);
    (app as GeoLibreAppAPI & { __catalogUnregister?: () => void }).__catalogUnregister = unregister ?? undefined;
  },
  deactivate(app) {
    app.closeRightPanel?.(CATALOG_BROWSER_PLUGIN_ID);
    (app as GeoLibreAppAPI & { __catalogUnregister?: () => void }).__catalogUnregister?.();
  },
};

export default maplibreCatalogBrowserPlugin;
