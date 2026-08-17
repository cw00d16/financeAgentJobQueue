# ---------------------------------------------------------------
# S3 — React frontend static hosting
# CloudFront sits in front; S3 is NOT public directly. The build/sync is
# owned entirely by CI (see .github/workflows/deploy.yml's deploy-frontend
# job) — Terraform only provisions the bucket, not its contents.
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
