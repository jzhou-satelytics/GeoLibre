variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "geolibre-mvp"
}

variable "route53_zone_name" {
  type    = string
  default = "satelytics.com"
}

variable "hostname" {
  type    = string
  default = "geolibre-mvp.satelytics.com"
}

variable "allowed_cidr" {
  type        = string
  description = "CIDR allowed to reach the disposable ALB. Replace when your public IP changes."
  default     = "199.83.110.242/32"
}

variable "image" {
  type        = string
  description = "ECR image URI. Empty uses the stack ECR repository latest tag."
  default     = ""
}

variable "db_name" {
  type    = string
  default = "geolibre"
}


variable "network_acl_id" {
  type        = string
  description = "Existing subnet network ACL used by the disposable default-VPC test subnets."
  default     = "acl-f9e01d9d"
}
variable "db_user" {
  type    = string
  default = "geolibre"
}
