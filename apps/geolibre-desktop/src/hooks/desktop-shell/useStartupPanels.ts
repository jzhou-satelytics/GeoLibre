import type { MapEngine } from "@geolibre/map";
import { S3_BROWSER_PLUGIN_ID } from "@geolibre/plugins";
import { useEffect, useRef, type RefObject } from "react";
import { useDesktopSettingsStore } from "../useDesktopSettings";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { createAppAPI, getPluginManager } from "../usePlugins";

interface StartupPanelsOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
}

/**
 * Opens the panels Settings → Startup asks for (the S3 Browser), once per page
 * load, after the map and plugins are ready.
 *
 * The S3 Browser is session-scoped, so the startup project's plugin restore
 * leaves it open whichever runs first. The read-only viewer never opens it.
 *
 * A deployment can also open the panel for every visitor with
 * GEOLIBRE_S3_BROWSER_STARTUP=1 (runtime env → deployment env), which is how a
 * managed private-data deployment makes its S3 access the front door without
 * touching each device's settings.
 *
 * @param options - The map engine, the viewer flag, and the readiness signals.
 */
export function useStartupPanels({
  mapControllerRef,
  viewer,
  externalPluginsReady,
  mapReadyGeneration,
}: StartupPanelsOptions): void {
  const handled = useRef(false);
  const openS3BrowserSetting = useDesktopSettingsStore(
    (state) => state.desktopSettings.startup.openS3Browser,
  );
  const deploymentOpensS3Browser =
    ["1", "true"].includes(
      (readDeploymentEnvValue("VITE_GEOLIBRE_S3_BROWSER_STARTUP") ?? "").trim().toLowerCase(),
    ) === true;
  const openS3Browser = openS3BrowserSetting || deploymentOpensS3Browser;
  useEffect(() => {
    if (handled.current || viewer || !externalPluginsReady || !mapReadyGeneration) return;
    if (!mapControllerRef.current) return;
    handled.current = true;
    const manager = getPluginManager();
    if (!openS3Browser || manager.isActive(S3_BROWSER_PLUGIN_ID)) return;
    void Promise.resolve(manager.activate(S3_BROWSER_PLUGIN_ID, createAppAPI(mapControllerRef)))
      .then((activated) => {
        if (!activated) console.warn("[GeoLibre] Could not open the S3 Browser at startup");
      })
      .catch((error) => console.warn("[GeoLibre] Could not open the S3 Browser at startup", error));
  }, [externalPluginsReady, mapControllerRef, mapReadyGeneration, openS3Browser, viewer]);
}
