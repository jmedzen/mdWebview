FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY server.js app.js index.html style.css ./

# Create a default md folder
RUN mkdir -p /app/md

# Expose default port
EXPOSE 8330

# Start server
CMD ["node", "server.js"]
