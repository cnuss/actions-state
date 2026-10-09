terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

variable "secret" {
  type      = string
  sensitive = true
}

resource "null_resource" "smoke" {
  triggers = {
    value      = "smoke"
    secret_sha = nonsensitive(sha256(var.secret))
  }
}

output "greeting" {
  value = "hello"
}

output "id" {
  value = null_resource.smoke.id
}

output "secret_sha" {
  value = null_resource.smoke.triggers.secret_sha
}

output "secret" {
  value     = var.secret
  sensitive = true
}

output "environments" {
  value = {
    prod = { region = "us-east-1", replicas = 3, tags = { team = "core", tier = "web" } }
    dev  = { region = "us-west-2", replicas = 1, tags = { team = "core", tier = "web" } }
  }
}

output "subnets" {
  value = [
    { cidr = "10.0.0.0/24", zones = ["a", "b"] },
    { cidr = "10.0.1.0/24", zones = ["c"] },
  ]
}
