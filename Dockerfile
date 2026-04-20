FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bounce_templates ./bounce_templates
COPY .env.example ./.env.example

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["npm", "start"]
