# Use official Node LTS slim image
FROM node:20-alpine

# Create app directory and set working dir
WORKDIR /usr/src/app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only (smaller image)
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Use environment variable for port (default 5000)
ENV NODE_ENV=production
ENV PORT=5000

# Expose the port the app listens on
EXPOSE 5000

# Run as non-root user for security (node user exists in official image)
USER node

# Use npm start so we don't hardcode entry file name
CMD ["npm", "start"]
