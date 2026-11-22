# BigCapital wrapper for Railway. Upstream ships two images (the NestJS API server and an nginx image holding the React app) and
# an Envoy proxy that splits /api from everything else. Railway's edge already terminates TLS, so this one image holds both: the
# built web app is copied out of the official webapp image and a small Node front door serves it and forwards /api to the server.
# The stock stack has no first-account story: whoever reaches the sign-up page first owns the books. This image starts the API
# on a private port with sign-up closed to everyone except ADMIN_EMAIL, creates that owner, and only then opens ONE public port.
# upstream: bigcapitalhq/bigcapital
# v0.25.48 is the newest release at build time (checked against the GitHub releases API on 2026-11-22).
FROM bigcapitalhq/webapp:v0.25.48@sha256:5b55f04f972c73ab3467da8fa0a276a95fc20256fb00122d20955bee372857e7 AS webapp

# upstream: bigcapitalhq/bigcapital
FROM bigcapitalhq/server:v0.25.48@sha256:db7e750f2a7724b91ebcea4785b18a57e5a51d0a641172393f7eff07d9bba531

# Baked so the deploy form stays empty: a literal template variable publishes as a blank required field. S3_BUCKET is needed to boot at all
# (the attachments module builds its multer-s3 storage at startup and throws "bucket is required"); uploads still need S3_ENDPOINT and keys.
ENV DB_CHARSET=utf8 \
    SYSTEM_DB_NAME=bigcapital_system \
    TENANT_DB_NAME_PERFIX=bigcapital_tenant_ \
    SIGNUP_EMAIL_CONFIRMATION=false \
    CLICKHOUSE_ENABLED=false \
    AI_ASSISTANT_ENABLED=false \
    S3_BUCKET=bigcapital \
    EXCHANGE_RATE_SERVICE=open-exchange-rate

COPY --from=webapp --chown=nodejs:nodejs /usr/share/nginx/html /app/webapp
COPY --chown=nodejs:nodejs boot.mjs /app/railway-boot.mjs

EXPOSE 8080
CMD ["node", "/app/railway-boot.mjs"]
