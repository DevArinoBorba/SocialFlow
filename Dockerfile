FROM node:24.19.0-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.19.0
WORKDIR /app

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 3001 3002 3003

ARG COMMIT_SHA=""
ARG REPO_URL="https://github.com/DevArinoBorba/SocialFlow"

LABEL org.opencontainers.image.title="SocialFlow" \
      org.opencontainers.image.description="SocialFlow unified immutable container image for Web, API, Worker and Prisma Migrations" \
      org.opencontainers.image.source="${REPO_URL}"

CMD ["sh", "-c", "exec pnpm --filter @socialflow/web start"]
