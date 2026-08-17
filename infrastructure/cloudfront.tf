# ---------------------------------------------------------------
# CloudFront — CDN in front of the S3 static frontend
#
# No custom domain, no ACM cert — the default *.cloudfront.net domain
# already gets HTTPS via CloudFront's built-in certificate, which is all
# a personal-use single-page tool needs. No second origin for the API
# either: the browser calls API Gateway's HTTPS URL directly (CORS on the
# API is already open, see api_gateway.tf), so there's nothing to proxy.
# PriceClass_100 (US/Canada/Europe only) is the cheapest tier, and at this
# traffic level the whole thing stays inside CloudFront's/S3's free tier.
# ---------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.prefix}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "static" {
  name        = "${local.prefix}-static-cache"
  min_ttl     = 0
  default_ttl = 86400    # 1 day
  max_ttl     = 31536000 # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

locals {
  s3_origin_id = "S3-${aws_s3_bucket.frontend.bucket}"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.static.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
