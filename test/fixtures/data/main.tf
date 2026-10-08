variable "value" {
  type    = string
  default = "one"
}

variable "sleep" {
  type    = number
  default = 0
}

# Replaced whenever value changes, so every apply that changes value writes a
# new serial; the provisioner holds the apply open for var.sleep seconds.
resource "terraform_data" "data" {
  input            = var.value
  triggers_replace = var.value

  provisioner "local-exec" {
    command = "sleep ${var.sleep}"
  }
}

output "value" {
  value = terraform_data.data.output
}
