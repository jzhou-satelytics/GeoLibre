# Entra federated access: browser signs in with Entra (workforce tenant),
# then exchanges the Entra ID token directly with AWS STS
# (AssumeRoleWithWebIdentity) for temporary S3 credentials.
#
# Probed 2026-10-23: STS answers browser CORS on both the global and regional
# endpoints (Access-Control-Allow-Origin: *), so the exchange runs entirely in
# the browser — no Cognito, no credential broker backend.
#
# Requires the Entra app registration first (see entra-setup.md):
#   - var.entra_tenant_id: the directory (tenant) GUID
#   - var.entra_client_id: the app registration's Application (client) ID
#
# The provider URL must match the `iss` claim of the v2.0 tokens Entra issues.

variable "entra_tenant_id" {
  type        = string
  description = "Entra directory (tenant) GUID, e.g. 00000000-0000-0000-0000-000000000000"
  default     = ""
}

variable "entra_client_id" {
  type        = string
  description = "Entra app registration Application (client) ID — the OIDC audience"
  default     = ""
}

locals {
  entra_enabled = var.entra_tenant_id != "" && var.entra_client_id != ""
  entra_issuer  = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
}

# TLS thumbprints of login.microsoftonline.com (leaf + intermediates + root),
# fetched 2026-10-23. AWS validates the chain presented with each token;
# listing the full chain avoids breakage on CA rotation of the leaf.
locals {
  entra_thumbprints = [
    "3ed688e5f77c9869a2cd9baf8e9e94c633396f21", # stamp2.login.microsoftonline.com
    "da6d0400641b45aecc595d24e5037aa6bc09c358", # Microsoft TLS G2 RSA CA OCSP 04
    "b5ee89e77326ab2bf1775bd99c19a28947ff8184", # Microsoft TLS RSA Root G2
  ]
}

# Container environment entries for the web build's Entra S3 session (read by
# docker/entrypoint.sh, which republishes them into the runtime config). The
# try() covers a stack built without Entra variables, where the role resource
# has count = 0 and indexing it would fail plan evaluation.
locals {
  entra_env = local.entra_enabled ? [
    { name = "GEOLIBRE_ENTRA_TENANT_ID", value = var.entra_tenant_id },
    { name = "GEOLIBRE_ENTRA_CLIENT_ID", value = var.entra_client_id },
    { name = "GEOLIBRE_ENTRA_ROLE_ARN", value = try(aws_iam_role.s3_browser[0].arn, "") },
    {
      name  = "GEOLIBRE_ENTRA_S3_BUCKETS"
      value = "${aws_s3_bucket.data.bucket},${local.data_repository_bucket}"
    },
    { name = "GEOLIBRE_ENTRA_REGION", value = var.aws_region },
  ] : []
}

resource "aws_iam_openid_connect_provider" "entra" {
  count = local.entra_enabled ? 1 : 0

  url             = local.entra_issuer
  client_id_list  = [var.entra_client_id]
  thumbprint_list = local.entra_thumbprints
}

# Trust policy: only this Entra app's tokens (audience match) may assume the role.
resource "aws_iam_role" "s3_browser" {
  count = local.entra_enabled ? 1 : 0

  name = "${local.name}-s3-browser"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.entra[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(local.entra_issuer, "https://", "")}:aud" = var.entra_client_id
        }
      }
    }]
  })
}

# Read/write on the disposable test bucket, read-only on the shared data
# repository scoped to sources/ (ListBucket is prefix-conditioned, so the rest
# of that repository stays invisible). No delete anywhere: versioned objects
# and S3-side history are the recovery mechanism.
locals {
  data_repository_bucket = "satelytics-file-repository"
}

resource "aws_iam_role_policy" "s3_browser_data" {
  count = local.entra_enabled ? 1 : 0

  name = "${local.name}-s3-browser-data"
  role = aws_iam_role.s3_browser[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = "${aws_s3_bucket.data.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation",
        ]
        Resource = aws_s3_bucket.data.arn
      },
      {
        Sid = "FileRepositoryListSources"
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.data_repository_bucket}"
        Condition = {
          StringLike = { "s3:prefix" = ["sources", "sources/*"] }
        }
      },
      {
        Sid = "FileRepositoryReadSources"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${local.data_repository_bucket}/sources/*"
      },
      {
        Effect = "Deny"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
        ]
        Resource = "*"
      },
    ]
  })
}

output "entra_oidc_provider_arn" {
  value = local.entra_enabled ? aws_iam_openid_connect_provider.entra[0].arn : null
}

output "s3_browser_role_arn" {
  value = local.entra_enabled ? aws_iam_role.s3_browser[0].arn : null
}
