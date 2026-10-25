/**
 * Installs the S3 signer at import time, before any project restore can ask
 * for a signed URL. Imported for its side effect by `App.tsx`.
 */
import { useDesktopSettingsStore } from "../hooks/useDesktopSettings";
import { normalizeS3DefaultLocation } from "./s3-connections";
import { installS3Signer } from "./s3-signer";
import { entraS3SilentRestore, getSessionS3Connections } from "./entra-s3-auth";

// The Entra session connection (in-memory, rotated by the auth module) rides
// ahead of the user's own connections: its bucket patterns are set by the
// deployment, and session rotation invalidates the signer's caches directly.
installS3Signer(
  () => [
    ...getSessionS3Connections(),
    ...useDesktopSettingsStore.getState().desktopSettings.s3Connections,
  ],
  (listener) =>
    useDesktopSettingsStore.subscribe((state, previous) => {
      if (state.desktopSettings.s3Connections !== previous.desktopSettings.s3Connections) {
        listener();
      }
    }),
  {
    get: () => useDesktopSettingsStore.getState().desktopSettings.s3DefaultLocation,
    // Written through the settings store, whose persistence saves it with the
    // rest of the desktop settings.
    set: (location) => {
      const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
      setDesktopSettings({
        ...desktopSettings,
        s3DefaultLocation: normalizeS3DefaultLocation(location),
      });
    },
  },
);

// A tab that signed in earlier restores its Entra S3 session silently, so the
// S3 Browser works again after a reload without re-prompting.
void entraS3SilentRestore();
