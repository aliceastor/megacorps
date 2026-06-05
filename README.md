# MegaCorps Phase 1-3 MVP

Node.js + Fastify + Next.js 15 + Drizzle + PostgreSQL + Turborepo using npm workspaces.

## Run locally

1. Copy `.env.example` to `.env` and set `PORTAINER_PASS`.
2. Install dependencies with `npm install`.
3. Start the full stack with `docker-compose up --build`.
4. Open `http://localhost:3000`.

## Scripts

- `npm run test`
- `npm run typecheck`
- `npm run build`

## MVP scope

- Phase 1: auth endpoints, login/signup screens, shell, dashboard, theme toggle, locale string foundation.
- Phase 2: card CRUD, status transition validation, board UI, detail panel, Run Now button.
- Phase 3: agent CRUD, org chart, Portainer-backed Hermes adapter, assign/run storage.

No pnpm. No Redis.
