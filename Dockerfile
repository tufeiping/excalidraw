# Keep this file compatible with the *legacy* Docker builder used on the
# packaging machine: no `--platform=${BUILDPLATFORM}` and no `RUN --mount=...`
# (both are BuildKit-only and make plain `docker build` fail with
# `failed to parse platform : ""`). Single-arch builds only — build and run on
# the same architecture.
FROM node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

RUN yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

# the fork serves the app under /whiteboard (see vite `base`) and injects
# runtime configuration (collab/storage/AI endpoints) on container start
COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html/whiteboard
COPY ./docker/99-excalidraw-runtime-config.sh /docker-entrypoint.d/99-excalidraw-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/99-excalidraw-runtime-config.sh

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
