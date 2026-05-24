# Deployment Guide

## Overview

This guide covers deploying and configuring pi-research for various use cases, including development, production, and containerized environments.

## Prerequisites

- Node.js >= 22.13.0
- pi CLI installed and configured
- LLM in pi with 100k+ context window
- Internet access (for web research)

---

## Installation

### Standard Installation

Install from npm:

```bash
pi install npm:@lincoln504/pi-research
```

This automatically:
- Installs dependencies
- Downloads stealth browser engine (camoufox)
- Sets up embedding model
- Runs initialization scripts

### Local Installation

For development or testing:

```bash
# Clone repository
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research

# Install dependencies
npm install

# Run setup
npm run setup

# Install in pi
pi install .
```

---

## Configuration

### Environment Variables

Create a `.env` file in your pi-research directory:

```bash
# Research Configuration
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=360000
PI_RESEARCH_WORKER_CONCURRENCY=3
PI_RESEARCH_SCRAPE_TIMEOUT_MS=15000
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=30000

# Knowledge Store
PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
PI_RESEARCH_EMBEDDING_DEVICE=webgpu

# Optional: External Services
PROXY_URL=socks5://127.0.0.1:9050
BRAVE_SEARCH_API_KEY=your_api_key_here
STACKEXCHANGE_API_KEY=your_api_key_here
SEARXNG_URL=https://your-searxng-instance.com
```

### Using the TUI Configuration

Access the interactive configuration dashboard:

```bash
/research-config
```

Navigate sections:
- **Settings:** Research parameters
- **Health:** System health checks
- **Errors:** Error reports
- **Knowledge:** Knowledge store management
- **Metrics:** Performance metrics

---

## System Dependencies

### Linux

Install required system dependencies:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2

# Fedora/RHEL
sudo dnf install -y \
  gcc-c++ \
  nss \
  nspr \
  atk \
  at-spi2-atk \
  cups-libs \
  libdrm \
  libxkbcommon \
  libXcomposite \
  libXdamage \
  libXfixes \
  libXrandr \
  mesa-libgbm \
  alsa-lib

# Arch Linux
sudo pacman -S --needed \
  base-devel \
  nss \
  nspr \
  atk \
  at-spi2-core \
  cups \
  libdrm \
  libxkbcommon \
  libxcomposite \
  libxdamage \
  libxfixes \
  libxrandr \
  mesa \
  alsa-lib
```

### macOS

macOS requires no additional system dependencies. The installer handles everything.

### Windows

Install Visual Studio Build Tools:

```powershell
# Download and install Visual Studio Build Tools
# https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022

# Or using winget
winget install Microsoft.VisualStudio.2022.BuildTools
```

---

## Browser Engine Setup

### Automatic Setup

The standard installation automatically downloads and sets up camoufox:

```bash
pi install npm:@lincoln504/pi-research
```

### Manual Setup

If automatic setup fails:

```bash
# Run setup script
npm run setup

# Or install browsers only
npm run install:browsers
```

### Troubleshooting Browser Setup

If browser installation fails:

```bash
# Clean up and retry
rm -rf ~/.camoufox
npm run install:browsers
```

For network issues:

```bash
# Use proxy during installation
export HTTPS_PROXY=http://proxy.example.com:8080
npm run install:browsers
```

---

## Knowledge Store Setup

### Initial Setup

The knowledge store is initialized automatically on first use.

```typescript
import { KnowledgeStore } from '@lincoln504/pi-research';

const store = new KnowledgeStore();
await store.initialize();
```

### Manual Model Download

Download embedding models manually:

```bash
# Download default model
npm run models:download

# Force re-download
npm run models:download:force
```

### Custom Model Path

Specify a custom model path:

```bash
# In .env
PI_RESEARCH_EMBEDDING_MODEL=/path/to/custom/model
```

---

## Deployment Scenarios

### Development Environment

For local development:

```bash
# Clone repository
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research

# Install dependencies
npm install

# Run setup
npm run setup

# Install in pi
pi install .

# Run tests
npm run test:unit
npm run test:integration
```

Development configuration:

```bash
# .env for development
PI_RESEARCH_VERBOSE=1
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=2
PI_RESEARCH_WORKER_CONCURRENCY=2
```

### Production Environment

For production use:

```bash
# Install from npm
pi install npm:@lincoln504/pi-research

# Configure for production
# .env
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
PI_RESEARCH_WORKER_CONCURRENCY=3
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=360000
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=30000
```

Production best practices:

1. **Set appropriate timeouts:**
   ```bash
   PI_RESEARCH_RESEARCHER_TIMEOUT_MS=360000  # 6 minutes
   PI_RESEARCH_SCRAPE_TIMEOUT_MS=15000      # 15 seconds
   ```

2. **Disable verbose logging:**
   ```bash
   # Don't set PI_RESEARCH_VERBOSE
   ```

3. **Use WebGPU for performance:**
   ```bash
   PI_RESEARCH_EMBEDDING_DEVICE=webgpu
   ```

4. **Monitor health:**
   ```bash
   /health
   /health-history
   ```

### Containerized Deployment

For containerized environments:

```dockerfile
# Dockerfile
FROM node:22-bullseye

# Install system dependencies
RUN apt-get update && apt-get install -y \
  build-essential \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  && rm -rf /var/lib/apt/lists/*

# Install pi (example)
RUN npm install -g @mariozechner/pi-cli

# Install pi-research
RUN pi install npm:@lincoln504/pi-research

# Set working directory
WORKDIR /workspace

# Configure environment
ENV PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
ENV PI_RESEARCH_WORKER_CONCURRENCY=3
ENV PI_RESEARCH_EMBEDDING_DEVICE=cpu  # No GPU in container

# Run health check on startup
CMD pi && /health
```

Build and run:

```bash
# Build image
docker build -t pi-research .

# Run container
docker run -it --rm \
  -v $(pwd)/knowledge_db:/workspace/knowledge_db \
  pi-research
```

### Server/Remote Deployment

For remote or server deployment:

```bash
# SSH into server
ssh user@server

# Install Node.js (if needed)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pi (example)
npm install -g @mariozechner/pi-cli

# Install pi-research
pi install npm:@lincoln504/pi-research

# Configure
cat > ~/.pi-research/.env << EOF
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
PI_RESEARCH_WORKER_CONCURRENCY=3
PI_RESEARCH_EMBEDDING_DEVICE=cpu
EOF

# Run health check
pi
/health
```

---

## Upgrading

### Standard Upgrade

Upgrade to latest version:

```bash
pi install npm:@lincoln504/pi-research@latest
```

### Manual Upgrade

For local development:

```bash
# Pull latest changes
git pull origin main

# Update dependencies
npm install

# Run setup
npm run setup

# Reinstall in pi
pi install .
```

### Knowledge Store Migration

When upgrading between versions with different embedding models:

```bash
# Automatic migration on first use
/research-config knowledge migrate re-embed

# Or clear and start fresh
/research-config knowledge migrate drop
```

---

## Verification

Verify your installation:

```bash
# Start pi
pi

# Run health check
/health

# Run a test research
/research test research query

# Check knowledge store
/research-config knowledge status
```

Expected output:
```
✅ System health check passed. All components operational.

✅ Research complete

Knowledge Store Status:
  Initialized: Yes
  Vectors: 0
  Model: Xenova/all-MiniLM-L6-v2
```

---

## Troubleshooting

### Installation Fails

**Issue:** Installation fails with errors

**Solution:**
```bash
# Clean up
rm -rf node_modules
rm package-lock.json

# Reinstall
npm install
npm run setup
```

### Browser Not Working

**Issue:** Browser operations fail

**Solution:**
```bash
# Run health check
/health

# Check browser component specifically
/research-config health run

# Reinstall browsers
npm run install:browsers:force
```

### Knowledge Store Errors

**Issue:** Knowledge store initialization fails

**Solution:**
```bash
# Clear knowledge store
/research-config knowledge clear

# Reinitialize
/research-config knowledge migrate drop
```

### Permission Errors

**Issue:** Permission denied errors

**Solution:**
```bash
# Fix knowledge_db permissions
chmod 755 knowledge_db
chmod 644 knowledge_db/*
```

See [Troubleshooting Guide](./troubleshooting.md) for more issues.

---

## Related

- [Architecture Overview](../architecture/overview.md)
- [Configuration Guide](./performance-tuning.md)
- [Troubleshooting Guide](./troubleshooting.md)
- [Health Check API](../api/health-check.md)

---

**Last Updated:** 2026-05-23