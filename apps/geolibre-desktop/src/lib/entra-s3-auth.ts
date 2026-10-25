/**
 * Entra-federated S3 access for the browser build.
 *
 * The deployment names its Entra tenant, app registration, and the IAM role
 * the browser assumes; this module signs the user in with Entra (PKCE, popup
 * through the shared `oauth-callback.html` relay), exchanges the resulting ID
 * token with AWS STS (`AssumeRoleWithWebIdentity`), and hands the temporary
 * credentials to the app's S3 signer as an in-memory connection. Nothing is
 * persisted beyond the tab's session storage, and only the Entra refresh
 * token is stored there — the AWS credentials stay in memory and are replaced
 * before they expire.
 *
 * Everything here is public by design: the tenant ID, client ID, and role ARN
 * are exactly the values the browser needs to run the exchange, and the role
 * trust policy (see `infra/terraform/test/entra.tf`) is what actually grants
 * access. STS answers browser CORS on this flow (probed 2026-10-23), so there
 * is no credential backend.
 */

import { parseBucketPatterns, type S3Connection } from "./s3-connections";
import { clearS3SignerCaches } from "./s3-signer";
import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

/** How long the STS credentials live when minted (STS accepts 900–43200). */
const SESSION_SECONDS = 3600;
/** Credentials this close to expiry are renewed proactively. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;
const CONNECTION_ID = "entra-session";
const REFRESH_STORAGE_KEY = "geolibre:entra-s3:refresh";
const ENTRA_SCOPE = "openid profile offline_access";
/** The shared popup relay's message type (`oauth-callback.html`). */
const CALLBACK_MESSAGE_TYPE = "geolibre-share-oauth";

export interface EntraS3Config {
  tenantId: string;
  clientId: string;
  roleArn: string;
  buckets: string[];
  region: string;
}

interface StsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface EntraS3Session {
  connection: S3Connection;
  /** Entra account label for the UI (mail, preferred username, or name). */
  account: string;
  /** Epoch ms when the STS credentials stop working. */
  credentials: StsCredentials;
  refreshToken: string;
  refreshTimer: number | undefined;
}

let session: EntraS3Session | null = null;
let renewal: Promise<void> | null = null;

function readConfig(env?: EnvRecord): EntraS3Config | null {
  const tenantId = readDeploymentEnvValue("VITE_GEOLIBRE_ENTRA_TENANT_ID", env);
  const clientId = readDeploymentEnvValue("VITE_GEOLIBRE_ENTRA_CLIENT_ID", env);
  const roleArn = readDeploymentEnvValue("VITE_GEOLIBRE_ENTRA_ROLE_ARN", env);
  const buckets = readDeploymentEnvValue("VITE_GEOLIBRE_ENTRA_S3_BUCKETS", env);
  const region = readDeploymentEnvValue("VITE_GEOLIBRE_ENTRA_REGION", env) ?? "us-east-1";
  if (!tenantId || !clientId || !roleArn || !buckets) return null;
  return {
    tenantId,
    clientId,
    roleArn,
    buckets: parseBucketPatterns(buckets.split(/[\s,]+/)),
    region,
  };
}

/** The deployment's Entra S3 configuration, or null when the feature is off. */
export function entraS3Config(): EntraS3Config | null {
  return readConfig();
}

/** The in-memory S3 connection the active Entra session provides, if any. */
export function getSessionS3Connections(): readonly S3Connection[] {
  return session ? [session.connection] : [];
}

export interface EntraS3Status {
  configured: boolean;
  signedIn: boolean;
  account?: string;
  /** Epoch ms when the STS credentials expire. */
  expiresAt?: number;
  buckets: string[];
}

/** What the settings UI renders. */
export function getEntraS3Status(): EntraS3Status {
  const config = entraS3Config();
  if (!config) return { configured: false, signedIn: false, buckets: [] };
  if (!session) return { configured: true, signedIn: false, buckets: config.buckets };
  return {
    configured: true,
    signedIn: true,
    account: session.account,
    expiresAt: session.credentials.expiresAt,
    buckets: config.buckets,
  };
}

// ---------------------------------------------------------------------------
// PKCE primitives (Web Crypto; the app is always served over HTTPS)
// ---------------------------------------------------------------------------

/** RFC 7636 base64url: unpadded, URL-safe alphabet. */
function base64url(bytes: ArrayBuffer): string {
  const raw = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

/** Decoded JWT payload (claim reads only — token validity is STS's job). */
function jwtClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * The redirect URI Entra returns the code to: the app origin, its base path,
 * and the shared relay page (`oauth-callback.html`, a separate Vite input at
 * the app root — the same page the share sign-in uses, since its relay is
 * provider-agnostic and binds by `state`).
 */
function callbackUri(): string {
  return new URL(
    `${import.meta.env.BASE_URL}oauth-callback.html`.replace(/\/{2,}/g, "/"),
    window.location.origin,
  ).toString();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class EntraS3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraS3Error";
  }
}

// ---------------------------------------------------------------------------
// Sign-in (authorization code + PKCE in a popup) and token renewal
// ---------------------------------------------------------------------------

/**
 * Signs the user in with Entra and activates the S3 session: the signer gains
 * a connection covering the configured buckets until sign-out or expiry.
 * Resolves once the S3 Browser panel can read with the session.
 */
export async function entraS3SignIn(): Promise<EntraS3Status> {
  const config = entraS3Config();
  if (!config) throw new EntraS3Error("Entra S3 sign-in is not configured for this deployment.");
  if (typeof window === "undefined") throw new EntraS3Error("Entra S3 sign-in needs a browser.");

  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const redirectUri = callbackUri();
  const authorizeUrl = new URL(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", ENTRA_SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("prompt", "select_account");

  // The relay page posts {type, code, state, error} to the opener; the state
  // match is this flow's binding, since the relay carries no issuer parameter.
  const popup = window.open(
    authorizeUrl.toString(),
    "geolibre-entra-s3",
    "popup,width=480,height=680",
  );
  if (!popup) throw new EntraS3Error("The sign-in popup was blocked. Allow popups for this site.");
  // Promise.withResolvers needs a lib target this repo has not adopted, so the
  // resolver pair lives in executor form here.
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: EntraS3Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== popup) return;
    const data = event.data as { type?: string; code?: string; state?: string; error?: string };
    if (data?.type !== CALLBACK_MESSAGE_TYPE) return;
    if (data.error) {
      rejectCode(new EntraS3Error("Entra sign-in was cancelled or refused."));
      return;
    }
    if (data.state !== state || !data.code) {
      rejectCode(new EntraS3Error("Entra sign-in returned an invalid callback."));
      return;
    }
    resolveCode(data.code);
  };
  const poll = window.setInterval(() => {
    if (popup.closed) rejectCode(new EntraS3Error("The Entra sign-in window was closed."));
  }, 500);
  const timer = window.setTimeout(
    () => rejectCode(new EntraS3Error("The Entra sign-in timed out.")),
    10 * 60 * 1000,
  );
  window.addEventListener("message", onMessage);
  let code: string;
  try {
    code = await codePromise;
  } finally {
    window.removeEventListener("message", onMessage);
    window.clearInterval(poll);
    window.clearTimeout(timer);
  }

  const tokens = await entraTokenRequest(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      scope: ENTRA_SCOPE,
      code_verifier: verifier,
    }),
  );
  try {
    await validateIdToken(config, tokens.id_token, nonce);
    await activateSession(config, tokens.id_token, tokens.refresh_token);
    // The refresh token is only stored once a session actually starts, so a
    // failed STS exchange leaves nothing half-initialized behind.
    sessionStorage.setItem(REFRESH_STORAGE_KEY, tokens.refresh_token);
  } catch (error) {
    sessionStorage.removeItem(REFRESH_STORAGE_KEY);
    throw error;
  }
  return getEntraS3Status();
}

/** Signs out: drops the session, credentials, renewal timer, and stored refresh token. */
export function entraS3SignOut(): void {
  stopRenewal();
  session = null;
  renewal = null;
  sessionStorage.removeItem(REFRESH_STORAGE_KEY);
  clearS3SignerCaches();
  // Mirrors the activateSession dispatch: mounted panels drop the session's
  // connection the same way they picked it up.
  window.dispatchEvent(new Event("geolibre:s3-connections-changed"));
}

/**
 * Restores the session from a stored refresh token without user interaction.
 * Called once at app start; resolves silently when there is nothing to do.
 */
export async function entraS3SilentRestore(): Promise<void> {
  if (session || renewal) return;
  const config = entraS3Config();
  const refreshToken = sessionStorage.getItem(REFRESH_STORAGE_KEY);
  if (!config || !refreshToken) return;
  renewal = renew(config, refreshToken)
    .catch((error: unknown) => {
      // A rejected refresh means the session is gone (password change, tenant
      // policy): drop everything so the next sign-in starts clean.
      sessionStorage.removeItem(REFRESH_STORAGE_KEY);
      if (error instanceof Error) {
        console.warn("[GeoLibre] Entra S3 session restore failed", error.message);
      }
    })
    .finally(() => {
      renewal = null;
    });
  await renewal;
}

function stopRenewal(): void {
  if (session?.refreshTimer !== undefined) window.clearTimeout(session.refreshTimer);
}

function scheduleRenewal(config: EntraS3Config): void {
  stopRenewal();
  if (!session) return;
  const delay = Math.max(60_000, session.credentials.expiresAt - RENEW_MARGIN_MS - Date.now());
  session.refreshTimer = window.setTimeout(() => {
    if (!session) return;
    renewal = renew(config, session.refreshToken)
      .catch((error: unknown) => {
        console.warn("[GeoLibre] Entra S3 session renewal failed", error);
      })
      .finally(() => {
        renewal = null;
      });
  }, delay);
}

async function renew(config: EntraS3Config, refreshToken: string): Promise<void> {
  const tokens = await entraTokenRequest(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      redirect_uri: callbackUri(),
      scope: ENTRA_SCOPE,
    }),
  );
  try {
    await validateIdToken(config, tokens.id_token);
    await activateSession(config, tokens.id_token, tokens.refresh_token);
    sessionStorage.setItem(REFRESH_STORAGE_KEY, tokens.refresh_token);
  } catch (error) {
    sessionStorage.removeItem(REFRESH_STORAGE_KEY);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entra token endpoint and the STS exchange
// ---------------------------------------------------------------------------

interface EntraTokens {
  id_token: string;
  refresh_token: string;
}

async function entraTokenRequest(config: EntraS3Config, body: URLSearchParams): Promise<EntraTokens> {
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
  );
  const payload = (await response.json().catch(() => null)) as
    | { id_token?: string; refresh_token?: string; error?: string; error_description?: string }
    | null;
  if (!response.ok || !payload?.id_token || !payload.refresh_token) {
    const detail = payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
    throw new EntraS3Error(`Entra token exchange failed: ${detail}`);
  }
  return { id_token: payload.id_token, refresh_token: payload.refresh_token };
}

/** The ID token must name this tenant, this app, and (interactively) this nonce. */
function validateIdToken(config: EntraS3Config, idToken: string, nonce?: string): void {
  const claims = jwtClaims(idToken);
  if (!claims) throw new EntraS3Error("Entra returned an unreadable ID token.");
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  if (!issuer.startsWith(`https://login.microsoftonline.com/${config.tenantId}`)) {
    throw new EntraS3Error("Entra ID token was issued by an unexpected tenant.");
  }
  if (claims.aud !== config.clientId) {
    throw new EntraS3Error("Entra ID token was issued for an unexpected application.");
  }
  if (nonce !== undefined && claims.nonce !== nonce) {
    throw new EntraS3Error("Entra ID token does not match the sign-in that started it.");
  }
}

/** Parses one element's text out of an S3/STS XML response. */
function xmlText(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
}

/**
 * Exchanges an Entra ID token for temporary AWS credentials. An unsigned STS
 * call, CORS-enabled (probed 2026-10-23): this runs entirely in the browser.
 */
async function stsAssumeRole(config: EntraS3Config, idToken: string): Promise<StsCredentials> {
  const url = new URL(`https://sts.${config.region}.amazonaws.com/`);
  url.searchParams.set("Action", "AssumeRoleWithWebIdentity");
  url.searchParams.set("Version", "2011-06-15");
  url.searchParams.set("RoleArn", config.roleArn);
  url.searchParams.set("RoleSessionName", "geolibre-entra");
  url.searchParams.set("WebIdentityToken", idToken);
  url.searchParams.set("DurationSeconds", String(SESSION_SECONDS));
  const response = await fetch(url.toString());
  const xml = await response.text();
  const expiration = xmlText(xml, "Expiration");
  if (!response.ok || !expiration) {
    const code = xmlText(xml, "Code") ?? `HTTP ${response.status}`;
    const message = xmlText(xml, "Message") ?? "";
    throw new EntraS3Error(
      `AWS STS refused the Entra token (${code}).${message ? ` ${message}` : ""} Check that the app registration matches the IAM OIDC provider and role trust policy.`,
    );
  }
  const accessKeyId = xmlText(xml, "AccessKeyId");
  const secretAccessKey = xmlText(xml, "SecretAccessKey");
  const sessionToken = xmlText(xml, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new EntraS3Error("AWS STS returned an incomplete credential response.");
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt: Date.parse(expiration) };
}

// ---------------------------------------------------------------------------
// Session activation: credentials → signer connection
// ---------------------------------------------------------------------------

/**
 * Exchanges the ID token with STS and installs the resulting credentials as
 * the signer's in-memory connection, invalidating the signer's caches so every
 * reader picks the fresh session up. Token-claim validation happens in the
 * callers, which know the flow's nonce.
 */
async function activateSession(
  config: EntraS3Config,
  idToken: string,
  refreshToken: string,
): Promise<void> {
  const credentials = await stsAssumeRole(config, idToken);
  const account =
    ([jwtClaims(idToken)?.preferred_username, jwtClaims(idToken)?.email, jwtClaims(idToken)?.name].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    )) || "Entra user";
  // Region stays blank on the connection: the signer then learns each bucket's
  // region from S3's wrong-region responses, so buckets in other regions keep
  // working without one connection-wide setting. config.region is only the
  // STS endpoint's region.
  const connection: S3Connection = {
    id: CONNECTION_ID,
    name: "Entra single sign-on",
    source: "keys",
    buckets: config.buckets,
    region: "",
    endpoint: "",
    pathStyle: false,
    profile: "",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    roleArn: "",
    externalId: "",
  };
  const previous = session;
  session = {
    connection,
    account,
    credentials,
    refreshToken,
    refreshTimer: previous?.refreshTimer,
  };
  scheduleRenewal(config);
  // Rotated credentials invalidate every cached presigned URL minted from the
  // previous session, so the next read signs against the new session.
  clearS3SignerCaches();
  // Panels that captured the connection list at mount (the S3 Browser) rebuild
  // on this event; the literal is mirrored by the S3 Browser plugin, which
  // cannot import this app module.
  window.dispatchEvent(new Event("geolibre:s3-connections-changed"));
}
