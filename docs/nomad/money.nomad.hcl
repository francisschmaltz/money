variable "image" {
  type        = string
  description = "Immutable GHCR image, for example ghcr.io/francisschmaltz/money:sha-FULL_COMMIT_SHA"
}

job "money" {
  datacenters = ["dc1"]
  type        = "service"

  update {
    max_parallel      = 1
    min_healthy_time  = "15s"
    healthy_deadline  = "3m"
    progress_deadline = "10m"
    auto_revert       = true
  }

  group "app" {
    count = 1

    network {
      port "http" {
        to = 3000
      }
    }

    service {
      name = "money"
      port = "http"

      meta {
        public_hostname = "money.example.com"
      }

      check {
        name     = "money-ready"
        type     = "http"
        path     = "/health/ready"
        interval = "10s"
        timeout  = "3s"
      }
    }

    restart {
      attempts = 3
      interval = "5m"
      delay    = "10s"
      mode     = "delay"
    }

    task "migrate" {
      driver = "docker"

      lifecycle {
        hook    = "prestart"
        sidecar = false
      }

      config {
        image   = var.image
        command = "npm"
        args    = ["run", "migrate"]
      }

      template {
        destination = "secrets/money.env"
        env         = true

        data = <<-EOT
          {{ with nomadVar "nomad/jobs/money" }}
          DATABASE_URL={{ .database_url | toJSON }}
          {{ end }}
        EOT
      }

      resources {
        cpu    = 100
        memory = 128
      }
    }

    task "server" {
      driver = "docker"

      config {
        image = var.image
        ports = ["http"]
      }

      env {
        NODE_ENV             = "production"
        HOST                 = "0.0.0.0"
        PORT                 = "3000"
        PUBLIC_BASE_URL      = "https://money.example.com"
        TRUST_PROXY          = "true"
        AUTH_MODE            = "oidc"
        PLAID_ENV            = "production"
        MCP_ALLOWED_HOSTS    = "money.example.com,money"
        NIGHTLY_INSIGHTS_HOUR_UTC = "9"
      }

      template {
        destination = "secrets/money.env"
        env         = true
        change_mode = "restart"

        data = <<-EOT
          {{ with nomadVar "nomad/jobs/money" }}
          DATABASE_URL={{ .database_url | toJSON }}
          PLAID_CLIENT_ID={{ .plaid_client_id | toJSON }}
          PLAID_SECRET={{ .plaid_secret | toJSON }}
          PLAID_WEBHOOK_URL={{ .plaid_webhook_url | toJSON }}
          DUO_OIDC_ISSUER={{ .duo_oidc_issuer | toJSON }}
          DUO_CLIENT_ID={{ .duo_client_id | toJSON }}
          DUO_CLIENT_SECRET={{ .duo_client_secret | toJSON }}
          DUO_AUTHORIZATION_URL={{ .duo_authorization_url | toJSON }}
          DUO_TOKEN_URL={{ .duo_token_url | toJSON }}
          DUO_REDIRECT_URI={{ .duo_redirect_uri | toJSON }}
          DUO_ALLOWED_EMAILS={{ .duo_allowed_emails | toJSON }}
          DUO_ADMIN_EMAILS={{ .duo_admin_emails | toJSON }}
          SESSION_SECRET={{ .session_secret | toJSON }}
          MCP_BEARER_TOKEN={{ .mcp_bearer_token | toJSON }}
          LM_STUDIO_BASE_URL={{ .lm_studio_base_url | toJSON }}
          LM_STUDIO_MODEL={{ .lm_studio_model | toJSON }}
          LM_STUDIO_API_KEY={{ .lm_studio_api_key | toJSON }}
          {{ end }}
        EOT
      }

      resources {
        cpu    = 400
        memory = 768
      }

      kill_signal  = "SIGTERM"
      kill_timeout = "30s"
    }

    task "worker" {
      driver = "docker"

      config {
        image   = var.image
        command = "node"
        args    = ["app/worker/index.js"]
      }

      env {
        NODE_ENV             = "production"
        PUBLIC_BASE_URL      = "https://money.example.com"
        PLAID_ENV            = "production"
        WORKER_POLL_INTERVAL_MS = "5000"
        NIGHTLY_INSIGHTS_HOUR_UTC = "9"
      }

      template {
        destination = "secrets/money.env"
        env         = true
        change_mode = "restart"

        data = <<-EOT
          {{ with nomadVar "nomad/jobs/money" }}
          DATABASE_URL={{ .database_url | toJSON }}
          PLAID_CLIENT_ID={{ .plaid_client_id | toJSON }}
          PLAID_SECRET={{ .plaid_secret | toJSON }}
          LM_STUDIO_BASE_URL={{ .lm_studio_base_url | toJSON }}
          LM_STUDIO_MODEL={{ .lm_studio_model | toJSON }}
          LM_STUDIO_API_KEY={{ .lm_studio_api_key | toJSON }}
          {{ end }}
        EOT
      }

      resources {
        cpu    = 300
        memory = 512
      }

      kill_signal  = "SIGTERM"
      kill_timeout = "30s"
    }
  }
}
