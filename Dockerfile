# Multi-stage production build for Nachtschicht (Vite + React + Three.js -> nginx)

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runner

# Remove default nginx welcome config and install our SPA + 3D asset config
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Fail fast at image build time if nginx config has syntax or MIME issues
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80/healthz > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
