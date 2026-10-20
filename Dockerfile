FROM nginx:1.24-alpine

COPY ./excalidraw-app/build /usr/share/nginx/html/whiteboard
COPY ./docker/99-excalidraw-runtime-config.sh /docker-entrypoint.d/99-excalidraw-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/99-excalidraw-runtime-config.sh

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
