# ---------------------------------------------------------------
# Lambda functions
# Terraform zips the source from the lambda/ directory at plan time.
#
# Each function gets its own IAM role rather than a shared one — the
# README calls for least-privilege IAM per worker, and with only four
# functions here that's cleaner than a shared-role-plus-exceptions setup:
# submitJob can only write jobs and enqueue; getJob can only read jobs;
# extractWorker can read/write jobs, enqueue research jobs (fan-in), and
# read the Anthropic secret; researchWorker can read/write jobs and read
# the secret, but never touches SQS directly.
# ---------------------------------------------------------------

# --- Common environment variables ---
locals {
  jobs_table_env = {
    JOBS_TABLE = aws_dynamodb_table.jobs.name
  }
}

# --- CloudWatch log groups — one per function ---
resource "aws_cloudwatch_log_group" "submit_job" {
  name              = "/aws/lambda/${local.prefix}-submit-job"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "get_job" {
  name              = "/aws/lambda/${local.prefix}-get-job"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "extract_worker" {
  name              = "/aws/lambda/${local.prefix}-extract-worker"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "research_worker" {
  name              = "/aws/lambda/${local.prefix}-research-worker"
  retention_in_days = 14
}

# --- Zip the Lambda source code ---
data "archive_file" "submit_job" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/submitJob"
  output_path = "${path.module}/.lambda_builds/submitJob.zip"
}

data "archive_file" "get_job" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/getJob"
  output_path = "${path.module}/.lambda_builds/getJob.zip"
}

# extractWorker and researchWorker are the only Lambdas with a real npm
# dependency (@anthropic-ai/sdk — submitJob/getJob only use the AWS SDK v3,
# which ships in the Node.js 20 Lambda runtime and needs no bundling).
# archive_file just zips whatever is on disk, so node_modules has to exist
# before it runs; this installs it whenever package.json/package-lock.json
# change, rather than relying on whoever runs `terraform apply` to
# remember a manual `npm install` step.
resource "null_resource" "extract_worker_npm_install" {
  triggers = {
    package_lock_hash = filesha256("${path.module}/../lambda/extractWorker/package-lock.json")
  }

  provisioner "local-exec" {
    command     = "npm ci --omit=dev"
    working_dir = "${path.module}/../lambda/extractWorker"
  }
}

data "archive_file" "extract_worker" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/extractWorker"
  output_path = "${path.module}/.lambda_builds/extractWorker.zip"
  depends_on  = [null_resource.extract_worker_npm_install]
}

resource "null_resource" "research_worker_npm_install" {
  triggers = {
    package_lock_hash = filesha256("${path.module}/../lambda/researchWorker/package-lock.json")
  }

  provisioner "local-exec" {
    command     = "npm ci --omit=dev"
    working_dir = "${path.module}/../lambda/researchWorker"
  }
}

data "archive_file" "research_worker" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/researchWorker"
  output_path = "${path.module}/.lambda_builds/researchWorker.zip"
  depends_on  = [null_resource.research_worker_npm_install]
}

# ---------------------------------------------------------------
# submitJob — PutItem on jobs, SendMessage on both queues
# ---------------------------------------------------------------

resource "aws_iam_role" "submit_job" {
  name = "${local.prefix}-submit-job-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "submit_job_basic" {
  role       = aws_iam_role.submit_job.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "submit_job" {
  name = "${local.prefix}-submit-job"
  role = aws_iam_role.submit_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Effect = "Allow"
        Action = ["sqs:SendMessage"]
        Resource = [
          aws_sqs_queue.extraction.arn,
          aws_sqs_queue.research.arn,
        ]
      }
    ]
  })
}

resource "aws_lambda_function" "submit_job" {
  function_name    = "${local.prefix}-submit-job"
  role             = aws_iam_role.submit_job.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.submit_job.output_path
  source_code_hash = data.archive_file.submit_job.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = 10

  environment {
    variables = merge(local.jobs_table_env, {
      EXTRACTION_QUEUE_URL = aws_sqs_queue.extraction.url
      RESEARCH_QUEUE_URL   = aws_sqs_queue.research.url
    })
  }

  depends_on = [aws_cloudwatch_log_group.submit_job]
}

# ---------------------------------------------------------------
# getJob — GetItem on jobs only
# ---------------------------------------------------------------

resource "aws_iam_role" "get_job" {
  name = "${local.prefix}-get-job-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "get_job_basic" {
  role       = aws_iam_role.get_job.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "get_job" {
  name = "${local.prefix}-get-job"
  role = aws_iam_role.get_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.jobs.arn
    }]
  })
}

resource "aws_lambda_function" "get_job" {
  function_name    = "${local.prefix}-get-job"
  role             = aws_iam_role.get_job.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.get_job.output_path
  source_code_hash = data.archive_file.get_job.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = 10

  environment {
    variables = local.jobs_table_env
  }

  depends_on = [aws_cloudwatch_log_group.get_job]
}

# ---------------------------------------------------------------
# extractWorker — GetItem/UpdateItem on jobs, SendMessage on research
# queue (fan-in), GetSecretValue on the Anthropic secret
# ---------------------------------------------------------------

resource "aws_iam_role" "extract_worker" {
  name = "${local.prefix}-extract-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "extract_worker_basic" {
  role       = aws_iam_role.extract_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "extract_worker" {
  name = "${local.prefix}-extract-worker"
  role = aws_iam_role.extract_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.research.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.anthropic_api_key.arn
      }
    ]
  })
}

# SQS invokes extractWorker directly via the event source mapping (see
# sqs.tf) — that mapping needs the Lambda's own execution role to have SQS
# read access on the source queue for the poller to work.
resource "aws_iam_role_policy" "extract_worker_sqs_receive" {
  name = "${local.prefix}-extract-worker-sqs-receive"
  role = aws_iam_role.extract_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ]
      Resource = aws_sqs_queue.extraction.arn
    }]
  })
}

resource "aws_lambda_function" "extract_worker" {
  function_name    = "${local.prefix}-extract-worker"
  role             = aws_iam_role.extract_worker.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.extract_worker.output_path
  source_code_hash = data.archive_file.extract_worker.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = var.extract_worker_timeout_seconds

  environment {
    variables = merge(local.jobs_table_env, {
      RESEARCH_QUEUE_URL   = aws_sqs_queue.research.url
      ANTHROPIC_SECRET_ARN = aws_secretsmanager_secret.anthropic_api_key.arn
      MAX_RECEIVE_COUNT    = tostring(var.extraction_max_receive_count)
    })
  }

  depends_on = [aws_cloudwatch_log_group.extract_worker]
}

# ---------------------------------------------------------------
# researchWorker — GetItem/UpdateItem on jobs, GetSecretValue on the
# Anthropic secret. No SQS SendMessage — research jobs have no children
# to fan out to.
# ---------------------------------------------------------------

resource "aws_iam_role" "research_worker" {
  name = "${local.prefix}-research-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "research_worker_basic" {
  role       = aws_iam_role.research_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "research_worker" {
  name = "${local.prefix}-research-worker"
  role = aws_iam_role.research_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.anthropic_api_key.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "research_worker_sqs_receive" {
  name = "${local.prefix}-research-worker-sqs-receive"
  role = aws_iam_role.research_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ]
      Resource = aws_sqs_queue.research.arn
    }]
  })
}

resource "aws_lambda_function" "research_worker" {
  function_name    = "${local.prefix}-research-worker"
  role             = aws_iam_role.research_worker.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.research_worker.output_path
  source_code_hash = data.archive_file.research_worker.output_base64sha256
  memory_size      = 512
  timeout          = var.research_worker_timeout_seconds

  environment {
    variables = merge(local.jobs_table_env, {
      ANTHROPIC_SECRET_ARN      = aws_secretsmanager_secret.anthropic_api_key.arn
      MAX_RECEIVE_COUNT         = tostring(var.research_max_receive_count)
      RESEARCH_MAX_ITERATIONS   = tostring(var.research_max_iterations)
      RESEARCH_MAX_TOTAL_TOKENS = tostring(var.research_max_total_tokens)
    })
  }

  depends_on = [aws_cloudwatch_log_group.research_worker]
}
