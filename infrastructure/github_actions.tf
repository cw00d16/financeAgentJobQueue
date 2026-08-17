# ---------------------------------------------------------------
# GitHub Actions CI/CD — OIDC-based IAM role
#
# This lets GitHub Actions assume an AWS role without storing
# long-lived AWS keys as GitHub secrets.
# ---------------------------------------------------------------

# OIDC provider — trust GitHub's token service
#
# This is an account-wide singleton (one provider per issuer URL per AWS
# account) — urlShortener's Terraform already created it in this AWS
# account, and chatApplication's Terraform references it the same way.
# Reference it instead of trying to create a second one (which fails with
# EntityAlreadyExists).
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# IAM role that GitHub Actions assumes via OIDC
resource "aws_iam_role" "github_actions" {
  name = "${local.prefix}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # AWS requires `sub` (or `job_workflow_ref`) itself to be scoped —
          # matching only the `repository` claim isn't accepted. GitHub now
          # embeds immutable numeric IDs into `sub`
          # (repo:owner@ownerId/name@repoId:ref:...) instead of the classic
          # repo:owner/name:ref:... format, so match both shapes.
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_repo}:*",
            "repo:${local.github_owner}@*/${local.github_name}@*:*",
          ]
        }
      }
    }]
  })
}

# Policy: deploy Lambda functions
resource "aws_iam_role_policy" "github_lambda" {
  name = "${local.prefix}-github-lambda"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "LambdaDeploy"
      Effect = "Allow"
      Action = [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunction",
        "lambda:PublishVersion",
        "lambda:UpdateAlias"
      ]
      Resource = [
        aws_lambda_function.submit_job.arn,
        aws_lambda_function.get_job.arn,
        aws_lambda_function.extract_worker.arn,
        aws_lambda_function.research_worker.arn,
      ]
    }]
  })
}

# Policy: read the Anthropic API key for the eval-harness CI jobs.
# Read-only, scoped to exactly the one secret the workers themselves use —
# no new copy of the key gets created anywhere.
resource "aws_iam_role_policy" "github_eval_secrets" {
  name = "${local.prefix}-github-eval-secrets"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadAnthropicKeyForEvals"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.anthropic_api_key.arn
    }]
  })
}
