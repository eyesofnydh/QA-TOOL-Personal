# Playwright's own image ships Chromium + all its OS-level dependencies already
# installed, which is normally the hardest part of deploying anything that uses
# Playwright. Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npm", "start"]
