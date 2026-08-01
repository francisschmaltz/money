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

    secret "registry_auth" {
      provider = "nomad"
      path     = "nomad/jobs/money"
    }

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

    task "money" {
      driver = "docker"

      config {
        image = "ghcr.io/francisschmaltz/money:latest"
        ports = ["http"]

        auth {
          username       = "francisschmaltz"
          password       = "${secret.registry_auth.ghcr_token}"
          server_address = "ghcr.io"
        }
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
          DATABASE_SSL={{ .database_ssl | toJSON }}
          DATABASE_SSL_REJECT_UNAUTHORIZED={{ .database_ssl_reject_unauthorized | toJSON }}
          PLAID_CLIENT_ID={{ .plaid_client_id | toJSON }}
          PLAID_SECRET={{ .plaid_secret | toJSON }}
          PLAID_WEBHOOK_URL={{ .plaid_webhook_url | toJSON }}
          APPLE_TEAM_ID={{ .apple_team_id | toJSON }}
          APPLE_MAPS_KEY_ID={{ .apple_maps_key_id | toJSON }}
          APPLE_MAPS_PRIVATE_KEY={{ .apple_maps_private_key | toJSON }}
          DUO_OIDC_ISSUER={{ .duo_oidc_issuer | toJSON }}
          DUO_CLIENT_ID={{ .duo_client_id | toJSON }}
          DUO_CLIENT_SECRET={{ .duo_client_secret | toJSON }}
          DUO_AUTHORIZATION_URL={{ .duo_authorization_url | toJSON }}
          DUO_TOKEN_URL={{ .duo_token_url | toJSON }}
          DUO_REDIRECT_URI={{ .duo_redirect_uri | toJSON }}
          DUO_ADMIN_EMAILS={{ .duo_admin_emails | toJSON }}
          SESSION_SECRET={{ .session_secret | toJSON }}
          MCP_BEARER_TOKEN={{ .mcp_bearer_token | toJSON }}
          MCP_PLAN_WRITE_TOKEN={{ .mcp_plan_write_token | toJSON }}
          LM_STUDIO_BASE_URL={{ .lm_studio_base_url | toJSON }}
          LM_STUDIO_MODEL={{ .lm_studio_model | toJSON }}
          LM_STUDIO_API_KEY={{ .lm_studio_api_key | toJSON }}
          {{ end }}
        EOT
      }

      resources {
        cpu    = 600
        memory = 1024
      }

      kill_signal  = "SIGTERM"
      kill_timeout = "30s"
    }
  }
}
