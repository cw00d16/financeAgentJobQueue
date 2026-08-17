output "frontend_url" {
  description = "CloudFront URL for the static frontend"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "frontend_s3_bucket_name" {
  description = "S3 bucket the frontend deploys to — set as the FRONTEND_S3_BUCKET GitHub Actions secret"
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — set as the CLOUDFRONT_DISTRIBUTION_ID GitHub Actions secret"
  value       = aws_cloudfront_distribution.frontend.id
}

output "api_gateway_url" {
  description = "HTTP API invoke URL (POST /jobs, GET /jobs/{id})"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/${aws_apigatewayv2_stage.main.name}"
}

output "jobs_table_name" {
  description = "DynamoDB jobs table name"
  value       = aws_dynamodb_table.jobs.name
}

output "extraction_queue_url" {
  description = "SQS extraction-queue URL"
  value       = aws_sqs_queue.extraction.url
}

output "research_queue_url" {
  description = "SQS research-queue URL"
  value       = aws_sqs_queue.research.url
}

output "extraction_dlq_url" {
  description = "SQS extraction dead-letter queue URL"
  value       = aws_sqs_queue.extraction_dlq.url
}

output "research_dlq_url" {
  description = "SQS research dead-letter queue URL"
  value       = aws_sqs_queue.research_dlq.url
}

output "dashboard_url" {
  description = "CloudWatch dashboard (jobs by outcome, latency, estimated spend, DLQ depth)"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "anthropic_api_key_secret_name" {
  description = "Secrets Manager secret to populate with `aws secretsmanager put-secret-value` (see infrastructure/secrets.tf)"
  value       = aws_secretsmanager_secret.anthropic_api_key.name
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions to assume"
  value       = aws_iam_role.github_actions.arn
}
