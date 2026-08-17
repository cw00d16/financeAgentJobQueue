# ---------------------------------------------------------------
# S3 — static frontend hosting
# CloudFront sits in front; S3 is NOT public directly. Just one small
# static HTML/JS file (no build step, no React) — see frontend/index.html.
# ---------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "frontend" {
  bucket = "${local.prefix}-frontend-${data.aws_caller_identity.current.account_id}"
}

# Block all public access — CloudFront uses OAC, not public URLs
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Bucket policy — only allows CloudFront OAC to read objects
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# Uploads frontend/index.html directly via Terraform — no build step, no
# CI required to get a working page live. The deploy-frontend CI job (see
# .github/workflows/deploy.yml) re-syncs it on future pushes once
# AWS_ROLE_ARN is set as a repo secret.
resource "aws_s3_object" "index_html" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "index.html"
  source       = "${path.module}/../frontend/index.html"
  etag         = filemd5("${path.module}/../frontend/index.html")
  content_type = "text/html"
}
