FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

# Create uploads directory
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/index.js"]
