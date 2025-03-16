FROM nginx:1.24-alpine

COPY ./excalidraw-app/build /usr/share/nginx/html/whiteboard

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
