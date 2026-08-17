terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Remote state in S3 — create this bucket manually once before running terraform init
  # or comment this block out to use local state while getting started
  #backend "s3" {
  #  bucket = "finance-agent-job-queue-tf-state"
  #  key    = "prod/terraform.tfstate"
  #  region = "us-east-2"
  #}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
