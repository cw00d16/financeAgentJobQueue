# ---------------------------------------------------------------
# Secrets Manager — Anthropic API key
#
# Deliberately no aws_secretsmanager_secret_version resource here: putting
# the key value in a Terraform resource means it's stored in plan output
# and state. Populate the secret once, out-of-band, after `terraform
# apply` creates it:
#
#   aws secretsmanager put-secret-value \
#     --secret-id financeagent-prod-anthropic-api-key \
#     --secret-string "sk-ant-..."
#
# Rotate the same way; extractWorker and researchWorker re-read it from
# Secrets Manager on their next cold start (each caches the value in memory
# across warm invocations).
# ---------------------------------------------------------------

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name        = "${local.prefix}-anthropic-api-key"
  description = "Anthropic API key used by extractWorker and researchWorker"
}
