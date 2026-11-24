# stockmgmt_02 실행 이미지. 운영 구성은 deploy/compose.yaml, 순서는 docs/OPERATIONS.md.
# 비밀값은 이미지에 넣지 않는다. 모두 실행할 때 환경변수로 받는다.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# 빌드는 DB 에 접속하지 않는다. 설정값이 있어야 하는 모듈이 있어 형식만 맞춘 값을 준다.
RUN DATABASE_URL=postgres://build:build@127.0.0.1/none npm run build

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# 실행에 필요한 것만 옮긴다. 마이그레이션·관리 스크립트(scripts/, db/, src/)도 같은 이미지로 실행한다.
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/src ./src
# 루트가 아닌 계정으로 실행한다.
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
