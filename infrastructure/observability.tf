# ---------------------------------------------------------------
# Observability
#
# Reads the structured JSON logs written by lambda/extractWorker/index.js
# and lambda/researchWorker/index.js's `log()` helpers — see those files
# for the exact field names these metric filters pattern-match against.
# ---------------------------------------------------------------

locals {
  # Claude Haiku 4.5 list pricing, per million tokens — feeds both the
  # dashboard's spend widget and the daily-spend alarm below. Update this
  # if the workers' MODEL env var ever changes models.
  haiku_input_price_per_mtok  = 1
  haiku_output_price_per_mtok = 5
}

# --- Turn the workers' structured logs into real CloudWatch metrics ---

resource "aws_cloudwatch_log_metric_filter" "extract_succeeded" {
  name           = "${local.prefix}-extract-succeeded"
  log_group_name = aws_cloudwatch_log_group.extract_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outcome = \"succeeded\" }"

  metric_transformation {
    name      = "ExtractionSucceeded"
    namespace = "FinanceAgent/Jobs"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "extract_failed" {
  name           = "${local.prefix}-extract-failed"
  log_group_name = aws_cloudwatch_log_group.extract_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outcome = \"failed\" }"

  metric_transformation {
    name      = "ExtractionFailed"
    namespace = "FinanceAgent/Jobs"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "extract_latency" {
  name           = "${local.prefix}-extract-latency"
  log_group_name = aws_cloudwatch_log_group.extract_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.latencyMs = \"*\" }"

  metric_transformation {
    name      = "ExtractionLatencyMs"
    namespace = "FinanceAgent/Jobs"
    value     = "$.latencyMs"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "research_succeeded" {
  name           = "${local.prefix}-research-succeeded"
  log_group_name = aws_cloudwatch_log_group.research_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outcome = \"succeeded\" }"

  metric_transformation {
    name      = "ResearchSucceeded"
    namespace = "FinanceAgent/Jobs"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "research_failed" {
  name           = "${local.prefix}-research-failed"
  log_group_name = aws_cloudwatch_log_group.research_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outcome = \"failed\" }"

  metric_transformation {
    name      = "ResearchFailed"
    namespace = "FinanceAgent/Jobs"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "research_latency" {
  name           = "${local.prefix}-research-latency"
  log_group_name = aws_cloudwatch_log_group.research_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.latencyMs = \"*\" }"

  metric_transformation {
    name      = "ResearchLatencyMs"
    namespace = "FinanceAgent/Jobs"
    value     = "$.latencyMs"
    unit      = "Milliseconds"
  }
}

# Token metrics — one filter pair per worker, summed together in the daily
# spend alarm/dashboard below.
resource "aws_cloudwatch_log_metric_filter" "extract_input_tokens" {
  name           = "${local.prefix}-extract-input-tokens"
  log_group_name = aws_cloudwatch_log_group.extract_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.inputTokens = \"*\" }"

  metric_transformation {
    name      = "InputTokens"
    namespace = "FinanceAgent/Jobs"
    value     = "$.inputTokens"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "extract_output_tokens" {
  name           = "${local.prefix}-extract-output-tokens"
  log_group_name = aws_cloudwatch_log_group.extract_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outputTokens = \"*\" }"

  metric_transformation {
    name      = "OutputTokens"
    namespace = "FinanceAgent/Jobs"
    value     = "$.outputTokens"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "research_input_tokens" {
  name           = "${local.prefix}-research-input-tokens"
  log_group_name = aws_cloudwatch_log_group.research_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.inputTokens = \"*\" }"

  metric_transformation {
    name      = "InputTokens"
    namespace = "FinanceAgent/Jobs"
    value     = "$.inputTokens"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "research_output_tokens" {
  name           = "${local.prefix}-research-output-tokens"
  log_group_name = aws_cloudwatch_log_group.research_worker.name
  pattern        = "{ $.event = \"job_processed\" && $.outputTokens = \"*\" }"

  metric_transformation {
    name      = "OutputTokens"
    namespace = "FinanceAgent/Jobs"
    value     = "$.outputTokens"
    unit      = "Count"
  }
}

# --- SNS topic + email subscription for alarms ---

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

# SNS emails a one-time confirmation link to alert_email after apply — the
# subscription stays PendingConfirmation (and won't deliver anything) until
# that link is clicked.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- Alarms ---

resource "aws_cloudwatch_metric_alarm" "extract_error_rate" {
  alarm_name          = "${local.prefix}-extract-error-rate"
  alarm_description   = "3+ extraction jobs failed in a 5-minute window"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 3
  treat_missing_data  = "notBreaching"

  metric_name = "ExtractionFailed"
  namespace   = "FinanceAgent/Jobs"
  period      = 300
  statistic   = "Sum"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "research_error_rate" {
  alarm_name          = "${local.prefix}-research-error-rate"
  alarm_description   = "3+ research jobs failed in a 5-minute window"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 3
  treat_missing_data  = "notBreaching"

  metric_name = "ResearchFailed"
  namespace   = "FinanceAgent/Jobs"
  period      = 300
  statistic   = "Sum"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# DLQ-depth alarm — the one addition to chatApplication's observability
# pattern this project needs. Jobs landing in a dead-letter queue at all is
# a signal something is systematically broken (bad prompt, Claude API
# outage, bad IAM), not just a per-job hiccup — and there's no equivalent
# signal in a system without a queue.
resource "aws_cloudwatch_metric_alarm" "extraction_dlq_depth" {
  alarm_name          = "${local.prefix}-extraction-dlq-depth"
  alarm_description   = "Messages present in the extraction DLQ — extraction jobs are failing all retries"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"

  metric_name = "ApproximateNumberOfMessagesVisible"
  namespace   = "AWS/SQS"
  period      = 300
  statistic   = "Maximum"

  dimensions = {
    QueueName = aws_sqs_queue.extraction_dlq.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "research_dlq_depth" {
  alarm_name          = "${local.prefix}-research-dlq-depth"
  alarm_description   = "Messages present in the research DLQ — research jobs are failing all retries"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"

  metric_name = "ApproximateNumberOfMessagesVisible"
  namespace   = "AWS/SQS"
  period      = 300
  statistic   = "Maximum"

  dimensions = {
    QueueName = aws_sqs_queue.research_dlq.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "daily_spend" {
  alarm_name          = "${local.prefix}-daily-spend"
  alarm_description   = "Estimated daily Claude spend (list pricing, input+output tokens, both job types) exceeded $${var.daily_spend_alert_threshold_usd}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.daily_spend_alert_threshold_usd
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "input_tokens"
    return_data = false
    metric {
      metric_name = "InputTokens"
      namespace   = "FinanceAgent/Jobs"
      period      = 86400
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "output_tokens"
    return_data = false
    metric {
      metric_name = "OutputTokens"
      namespace   = "FinanceAgent/Jobs"
      period      = 86400
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "estimated_spend"
    expression  = "(input_tokens/1000000*${local.haiku_input_price_per_mtok})+(output_tokens/1000000*${local.haiku_output_price_per_mtok})"
    label       = "Estimated daily spend (USD)"
    return_data = true
  }
}

# --- Dashboard ---

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.prefix}-jobs"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Jobs by Outcome"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["FinanceAgent/Jobs", "ExtractionSucceeded", { label = "Extraction succeeded" }],
            ["FinanceAgent/Jobs", "ExtractionFailed", { label = "Extraction failed" }],
            ["FinanceAgent/Jobs", "ResearchSucceeded", { label = "Research succeeded" }],
            ["FinanceAgent/Jobs", "ResearchFailed", { label = "Research failed" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Latency by Job Type"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          metrics = [
            ["FinanceAgent/Jobs", "ExtractionLatencyMs", { stat = "p50", label = "Extraction p50" }],
            ["FinanceAgent/Jobs", "ResearchLatencyMs", { stat = "p50", label = "Research p50" }],
            ["FinanceAgent/Jobs", "ResearchLatencyMs", { stat = "p99", label = "Research p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Estimated Claude Spend (USD)"
          view   = "timeSeries"
          region = var.aws_region
          period = 86400
          metrics = [
            [{ id = "e1", label = "Estimated spend ($)", expression = "(m1/1000000*${local.haiku_input_price_per_mtok})+(m2/1000000*${local.haiku_output_price_per_mtok})" }],
            ["FinanceAgent/Jobs", "InputTokens", { id = "m1", stat = "Sum", visible = false }],
            ["FinanceAgent/Jobs", "OutputTokens", { id = "m2", stat = "Sum", visible = false }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "DLQ Depth"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "Maximum"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.extraction_dlq.name, { label = "Extraction DLQ" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.research_dlq.name, { label = "Research DLQ" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 24
        height = 6
        properties = {
          title  = "Worker Lambda Health"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.extract_worker.function_name, { label = "extractWorker errors" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.research_worker.function_name, { label = "researchWorker errors" }],
            ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.extract_worker.function_name, { label = "extractWorker throttles" }],
            ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.research_worker.function_name, { label = "researchWorker throttles" }],
          ]
        }
      },
    ]
  })
}
