# Entra app registration (runbook)

One-time setup in the company workforce tenant. The browser build signs users
in with Entra (OIDC + PKCE) and exchanges the resulting ID token directly with
AWS STS — no credential backend (STS browser CORS verified 2026-10-23).

## 1. Register the application

Azure portal → **Microsoft Entra ID → App registrations → New registration**

| Setting | Value |
| --- | --- |
| Name | `GeoLibre Web` |
| Supported account types | **Single tenant** (this organization only) |
| Redirect URI | Platform **Single-page application (SPA)**, URI `https://geolibre-mvp.satelytics.com/oauth-callback.html` |

Add a second SPA redirect for local development: `http://localhost:5173/oauth-callback.html`.

The callback is the shared relay page (`oauth-callback.html`, also used by the
Project Share sign-in): the popup redirects there with `?code/&state/`, and the
page relays them to the app opener, which binds them to this flow by `state`.

## 2. Record the two identifiers

- **Application (client) ID** → `infra/terraform/test/entra.tf` `entra_client_id`
- **Directory (tenant) ID** → `infra/terraform/test/entra.tf` `entra_tenant_id`

Put both into `infra/terraform/test/terraform.tfvars`:

```hcl
entra_tenant_id = "00000000-0000-0000-0000-000000000000"
entra_client_id = "11111111-1111-1111-1111-111111111111"
```

Then `terraform apply` creates the IAM OIDC identity provider and the
`s3_browser` role (see `entra.tf`).

## 3. Admin consent

The tenant requires admin consent for new app registrations (a user sign-in
shows "Need admin approval" otherwise). Grant it tenant-wide from the CLI:

```bash
APP_SP=$(az ad sp show --id <client-id> --query id -o tsv)
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
az rest --method POST --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" \
  --headers 'Content-Type=application/json' \
  --body "{\"clientId\":\"$APP_SP\",\"consentType\":\"AllPrincipals\",\"principalId\":null,\"resourceId\":\"$GRAPH_SP\",\"scope\":\"openid profile offline_access\"}"
```

The portal equivalent is App registrations → GeoLibre Web → API permissions →
**Grant admin consent**. Do not use the `adminconsent?client_id=` URL for this
app: after consent it redirects to whichever registered reply URL it picks,
which may be the localhost dev URI.

## 4. Token configuration

Defaults are correct; nothing to change unless noted:

- **Supported account types:** single tenant → `iss` is
  `https://login.microsoftonline.com/{tenant}/v2.0`, which matches the Terraform
  provider URL exactly.
- **ID token audience (`aud`)** is automatically the app's client ID — this is
  the audience the IAM role's trust condition checks. No custom API scope or
  app service is needed for Phase 1.
- Enforce **PKCE-required / allow public client flows** is on by default for
  SPA registrations; leave it on.

Optional, for Phase 3 role-mapping (not required now):

- **Token configuration → Add groups claim** if you later want Entra group
  membership to influence which prefixes a user can reach.
- **App roles** if you later want a "data editor" vs "viewer" distinction.

## 5. Verify

After `terraform apply` and the admin-consent grant from step 3:

```bash
terraform output s3_browser_role_arn
# arn:aws:iam::534228481105:role/geolibre-mvp-s3-browser
```

A real browser test runs the app-side sign-in (Settings → Cloud Storage →
Entra single sign-on): the popup completes at Entra, the browser POSTs to STS
`AssumeRoleWithWebIdentity` with the Entra ID token, receives temporary
credentials, and the S3 Browser panel reads the bucket with them.
