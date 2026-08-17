# ---------------------------------------------------------------
# API Gateway v2 (HTTP API) — POST /jobs, GET /jobs/{id}
#
# Unauthenticated for v1 — this is a pet project with no user accounts
# (unlike chatApplication, which has Cognito). Add an authorizer later if
# this is ever exposed beyond personal use.
# ---------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins  = ["*"]
    allow_methods  = ["GET", "POST", "OPTIONS"]
    allow_headers  = ["Content-Type"]
    expose_headers = []
    max_age        = 86400
  }
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = var.environment
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format          = "$context.requestId $context.status"
  }

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

# --- POST /jobs — submitJob ---
resource "aws_apigatewayv2_integration" "submit_job" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.submit_job.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "submit_job" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /jobs"
  target    = "integrations/${aws_apigatewayv2_integration.submit_job.id}"
}

resource "aws_lambda_permission" "submit_job" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.submit_job.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# --- GET /jobs/{id} — getJob ---
resource "aws_apigatewayv2_integration" "get_job" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_job.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_job" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /jobs/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.get_job.id}"
}

resource "aws_lambda_permission" "get_job" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_job.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# CloudWatch log group for API Gateway access logs
resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${local.prefix}"
  retention_in_days = 14
}
