FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ src/
COPY config/ config/
COPY tsconfig.json ./

# Install tsx for running TypeScript at runtime
RUN npm install tsx

# Use direct tsx path (no npx overhead)
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
