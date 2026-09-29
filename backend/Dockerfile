# ASTERIA Copilot proxy — Hugging Face Docker Space (free, no card required)
# Stateless Express proxy; listens on 7860 as required by Spaces.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 7860
ENV PORT=7860

CMD ["node", "dist/index.js"]
