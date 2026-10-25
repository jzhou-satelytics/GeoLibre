output "test_url" {
  value = "https://${var.hostname}"
}

output "alb_dns_name" {
  value = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "s3_bucket" {
  value = aws_s3_bucket.data.bucket
}

output "basic_auth_user" {
  value = "tester"
}

output "basic_auth_password" {
  value     = random_password.basic_auth.result
  sensitive = true
}

output "entra_callback_url" {
  value = "https://${var.hostname}/oauth-callback.html"
}

output "entra_logout_url" {
  value = "https://${var.hostname}/"
}
