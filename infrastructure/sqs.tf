# ---------------------------------------------------------------
# SQS — two queues, not one. Extraction and research jobs have genuinely
# different SLAs (see README's Architecture section) — a stuck extraction
# job should be considered failed within a couple minutes, while a research
# job doing several tool-use rounds needs a much longer visibility timeout
# before SQS assumes the worker died and redelivers it.
# ---------------------------------------------------------------

resource "aws_sqs_queue" "extraction_dlq" {
  name                      = "${local.prefix}-extraction-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "extraction" {
  name = "${local.prefix}-extraction"

  # Comfortably longer than extract_worker_timeout_seconds (default 30s) to
  # cover cold start + the single Haiku call before SQS assumes the worker
  # died and redelivers the message.
  visibility_timeout_seconds = 90

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.extraction_dlq.arn
    maxReceiveCount     = var.extraction_max_receive_count
  })
}

resource "aws_sqs_queue" "research_dlq" {
  name                      = "${local.prefix}-research-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "research" {
  name = "${local.prefix}-research"

  # Comfortably longer than research_worker_timeout_seconds (default 300s)
  # to cover cold start + up to research_max_iterations+1 Haiku calls with
  # web search rounds before SQS assumes the worker died and redelivers.
  visibility_timeout_seconds = 900

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.research_dlq.arn
    maxReceiveCount     = var.research_max_receive_count
  })
}

# --- Event source mappings — batch_size=1 keeps idempotency reasoning
# simple: each Lambda invocation handles exactly one job. ---

resource "aws_lambda_event_source_mapping" "extraction_queue" {
  event_source_arn = aws_sqs_queue.extraction.arn
  function_name    = aws_lambda_function.extract_worker.arn
  batch_size       = 1
}

resource "aws_lambda_event_source_mapping" "research_queue" {
  event_source_arn = aws_sqs_queue.research.arn
  function_name    = aws_lambda_function.research_worker.arn
  batch_size       = 1
}
