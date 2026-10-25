# Disposable GeoLibre test stack

This stack is intentionally disposable. It uses the default VPC, a temporary
private S3 bucket, a small RDS PostgreSQL instance, ECS/Fargate, an ALB, ACM,
and Route 53. The ALB is restricted to `allowed_cidr` and the container uses a
smoke-test proxy identity until Entra OIDC is configured.

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars
# Update allowed_cidr if your public IP changed.
terraform init
terraform apply
```

The current image must already exist in ECR. Build and push it with the ECR
repository URL from `terraform output -raw ecr_repository_url`.

```bash
terraform output -raw ecr_repository_url
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <repository>
docker build --platform linux/amd64 -t <repository>:latest .
docker push <repository>:latest
terraform apply -var='image=<repository>:latest'
```

This test stack uses HTTP Basic Auth in addition to the IP allowlist. Retrieve
the generated password with:

```bash
terraform output -raw basic_auth_password
```

The catalog API uses a fixed smoke identity, not Entra. Do not expose this stack
by changing `allowed_cidr` to `0.0.0.0/0`. Configure Entra separately using the
`entra_callback_url` and `entra_logout_url` outputs before widening access.

## Destroy

```bash
terraform destroy
```

The S3 bucket is configured with `force_destroy = true`, the RDS instance skips
its final snapshot, and the ECR repository is disposable. Local Terraform state
contains generated database and Basic Auth secrets; protect or remove it after
destruction.
