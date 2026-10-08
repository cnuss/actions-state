terraform {
  backend "s3" {
    bucket = "never-used"
    key    = "never-used"
    region = "us-east-1"
  }
}

resource "terraform_data" "data" {
  input = "replaced"
}
