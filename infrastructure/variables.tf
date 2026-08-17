variable "aws_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Project name used in resource naming"
  type        = string
  default     = "finance-agent-job-queue"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "github_repo" {
  description = "GitHub repo in owner/repo format (e.g. cw00d16/financeAgentJobQueue). Used for OIDC trust."
  type        = string
}

variable "lambda_memory_mb" {
  description = "Memory allocated to submitJob/getJob/extractWorker. researchWorker overrides this — see lambda.tf."
  type        = number
  default     = 256
}

variable "extract_worker_timeout_seconds" {
  description = "extractWorker Lambda timeout — one Haiku call, no tools, should be fast"
  type        = number
  default     = 30
}

variable "research_worker_timeout_seconds" {
  description = "researchWorker Lambda timeout — up to MAX_RESEARCH_ITERATIONS+1 Haiku calls with web search"
  type        = number
  default     = 300
}

variable "extraction_max_receive_count" {
  description = "SQS redrive policy: extraction-queue maxReceiveCount before a message moves to the DLQ"
  type        = number
  default     = 3
}

variable "research_max_receive_count" {
  description = "SQS redrive policy: research-queue maxReceiveCount before a message moves to the DLQ"
  type        = number
  default     = 3
}

variable "research_max_iterations" {
  description = "Hard cap on research-phase Claude calls per research job, before the mandatory finalize call"
  type        = number
  default     = 5
}

variable "research_max_total_tokens" {
  description = "Belt-and-suspenders cumulative input+output token budget per research job"
  type        = number
  default     = 100000
}

variable "research_max_search_uses" {
  description = "Caps web_search's max_uses per research-phase call — the main cost lever, since each search is billed $0.01 flat on top of tokens and isn't reflected in token usage at all"
  type        = number
  default     = 5
}

variable "dynamodb_billing_mode" {
  description = "DynamoDB billing mode: PAY_PER_REQUEST or PROVISIONED"
  type        = string
  default     = "PAY_PER_REQUEST"
}

variable "alert_email" {
  description = "Email address for CloudWatch alarm notifications (worker error rate, DLQ depth, daily spend). SNS will send a one-time confirmation link to this address after apply."
  type        = string
}

variable "daily_spend_alert_threshold_usd" {
  description = "Estimated daily Claude spend (input + output tokens, list pricing) above which the daily-spend alarm fires"
  type        = number
  default     = 2
}

locals {
  prefix       = "financeagent-${var.environment}"
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]
}
