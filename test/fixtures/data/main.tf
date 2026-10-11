variable "value" {
  type    = string
  default = "one"
}

variable "sleep" {
  type    = number
  default = 0
}

# A command to hold the apply open with instead of sleeping.
variable "hold" {
  type    = string
  default = ""
}

# Replaced whenever value changes, so every apply that changes value writes a
# new serial; the provisioner holds the apply open for var.sleep seconds, or
# until var.hold exits.
resource "terraform_data" "data" {
  input            = var.value
  triggers_replace = var.value

  provisioner "local-exec" {
    command = var.hold != "" ? var.hold : "sleep ${var.sleep}"
  }
}

output "value" {
  value = terraform_data.data.output
}
