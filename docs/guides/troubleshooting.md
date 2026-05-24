# Troubleshooting Guide

This guide helps you diagnose and resolve common issues with pi-research.

## Table of Contents

- [General Issues](#general-issues)
- [Browser Issues](#browser-issues)
- [Knowledge Store Issues](#knowledge-store-issues)
- [Performance Issues](#performance-issues)
- [Network Issues](#network-issues)
- [Testing Issues](#testing-issues)

---

## General Issues

### Extension Not Loading

**Symptom:** Extension doesn't appear in pi or tools not available

**Diagnosis:**
```bash
# Check if extension is installed
pi list-extensions

# Check for errors
pi --verbose
```

**Solutions:**

1. **Reinstall extension:**
   ```bash
   pi install npm:@lincoln504/pi-research@latest
   ```

2. **Check Node.js version:**
   ```bash
   node --version  # Must be >= 22.13.0
   ```

3. **Clear pi cache:**
   ```bash
   rm -rf ~/.pi/cache
   pi install npm:@lincoln504/pi-research
   ```

---

### Research Tool Not Found

**Symptom:** `research` command not recognized

**Diagnosis:**
```bash
# Check available tools
/help

# Run health check
/health
```

**Solutions:**

1. **Verify extension loaded:**
   ```bash
   pi list-extensions
   ```

2. **Restart pi:**
   ```bash
   # Exit pi and restart
   /exit
   pi
   ```

3. **Check for errors in logs:**
   ```bash
   # Enable verbose logging
   PI_RESEARCH_VERBOSE=1 pi

   # Check for extension load errors
   ```

---

### Command Not Found

**Symptom:** `/research-config` or other commands not found

**Diagnosis:**
```bash
# List available commands
/help
```

**Solutions:**

1. **Verify extension is latest version:**
   ```bash
   pi install npm:@lincoln504/pi-research@latest
   ```

2. **Check extension loaded properly:**
   ```bash
   /health
   ```

3. **Restart pi session:**
   ```bash
   /exit
   pi
   ```

---

## Browser Issues

### Browser Installation Fails

**Symptom:** Error during browser installation

**Diagnosis:**
```bash
# Check installation logs
npm run setup

# Check for missing dependencies
npm list
```

**Solutions:**

1. **Install system dependencies:**

   **Linux (Debian/Ubuntu):**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential libnss3 libnspr4
   ```

   **macOS:** No action needed

   **Windows:** Install Visual Studio Build Tools

2. **Retry installation:**
   ```bash
   npm run install:browsers:force
   ```

3. **Check network connectivity:**
   ```bash
   curl -I https://github.com
   ```

---

### Browser Crashes

**Symptom:** Research fails with browser crash error

**Diagnosis:**
```bash
# Check health
/health

# Check browser specifically
/research-config health run

# Check error history
/research-config errors view
```

**Solutions:**

1. **Reduce worker concurrency:**
   ```bash
   # In .env
   PI_RESEARCH_WORKER_CONCURRENCY=1
   ```

2. **Increase timeouts:**
   ```bash
   PI_RESEARCH_SCRAPE_TIMEOUT_MS=30000
   ```

3. **Clear browser cache:**
   ```bash
   rm -rf ~/.camoufox
   npm run install:browsers
   ```

4. **Check system resources:**
   ```bash
   # Linux/macOS
   free -h
   df -h

   # Windows
   wmic OS get FreePhysicalMemory,TotalVisibleMemorySize
   ```

---

### Browser Timeout

**Symptom:** "Browser operation timed out" error

**Diagnosis:**
```bash
# Check timeout configuration
/research-config settings

# Check error logs
/research-config errors view
```

**Solutions:**

1. **Increase timeouts:**
   ```bash
   # In .env
   PI_RESEARCH_SCRAPE_TIMEOUT_MS=30000
   PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=60000
   ```

2. **Check network connectivity:**
   ```bash
   ping -c 3 duckduckgo.com
   ```

3. **Use proxy if needed:**
   ```bash
   PROXY_URL=socks5://127.0.0.1:9050
   ```

4. **Reduce concurrent operations:**
   ```bash
   PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
   ```

---

## Knowledge Store Issues

### Knowledge Store Initialization Fails

**Symptom:** Error initializing knowledge store

**Diagnosis:**
```bash
# Check knowledge store status
/research-config knowledge status

# Check health
/health
```

**Solutions:**

1. **Clear and reinitialize:**
   ```bash
   /research-config knowledge clear
   /research-config knowledge migrate drop
   ```

2. **Check file permissions:**
   ```bash
   chmod 755 knowledge_db
   chmod 644 knowledge_db/*
   ```

3. **Switch to CPU embedding:**
   ```bash
   PI_RESEARCH_EMBEDDING_DEVICE=cpu
   ```

---

### Migration Fails

**Symptom:** Knowledge store migration error

**Diagnosis:**
```bash
# Check migration status
/research-config knowledge status

# Check error logs
/research-config errors view
```

**Solutions:**

1. **Use drop strategy:**
   ```bash
   /research-config knowledge migrate drop
   ```

2. **Check disk space:**
   ```bash
   df -h
   ```

3. **Manually clear database:**
   ```bash
   rm -rf knowledge_db
   /research-config knowledge migrate drop
   ```

---

### Embedding Model Not Found

**Symptom:** Error loading embedding model

**Diagnosis:**
```bash
# Check model configuration
/research-config settings

# Try manual download
npm run models:download
```

**Solutions:**

1. **Download model manually:**
   ```bash
   npm run models:download:force
   ```

2. **Check network connectivity:**
   ```bash
   curl -I https://huggingface.co
   ```

3. **Use different model:**
   ```bash
   PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
   ```

---

## Performance Issues

### Slow Research

**Symptom:** Research takes longer than expected

**Diagnosis:**
```bash
# Check metrics
/research-config metrics

# Check worker concurrency
/research-config settings
```

**Solutions:**

1. **Use WebGPU for embeddings:**
   ```bash
   PI_RESEARCH_EMBEDDING_DEVICE=webgpu
   ```

2. **Increase worker concurrency:**
   ```bash
   PI_RESEARCH_WORKER_CONCURRENCY=5
   ```

3. **Reduce scrape batches for depth 0:**
   ```bash
   # TUI configuration
   /research-config settings
   # Reduce MAX_SCRAPE_BATCHES
   ```

4. **Use appropriate depth:**
   ```bash
   # Use depth 0 for simple queries
   /research simple query

   # Use depth 1 for standard research
   research standard query
   ```

---

### High Memory Usage

**Symptom:** High memory consumption during research

**Diagnosis:**
```bash
# Check memory usage
# Linux/macOS
ps aux | grep pi

# Windows
tasklist | findstr node
```

**Solutions:**

1. **Reduce concurrent researchers:**
   ```bash
   PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
   ```

2. **Reduce worker concurrency:**
   ```bash
   PI_RESEARCH_WORKER_CONCURRENCY=2
   ```

3. **Use CPU embeddings (less memory):**
   ```bash
   PI_RESEARCH_EMBEDDING_DEVICE=cpu
   ```

4. **Clear knowledge store periodically:**
   ```bash
   /research-config knowledge clear
   ```

---

### High CPU Usage

**Symptom:** High CPU usage during research

**Diagnosis:**
```bash
# Check CPU usage
# Linux/macOS
top -p $(pgrep -f pi)

# Windows
taskmgr
```

**Solutions:**

1. **Reduce worker concurrency:**
   ```bash
   PI_RESEARCH_WORKER_CONCURRENCY=2
   ```

2. **Use CPU embeddings (more predictable):**
   ```bash
   PI_RESEARCH_EMBEDDING_DEVICE=cpu
   ```

3. **Reduce scrape batches:**
   ```bash
   # TUI configuration
   /research-config settings
   # Reduce MAX_SCRAPE_BATCHES to 1
   ```

---

## Network Issues

### Connection Refused

**Symptom:** "Connection refused" errors

**Diagnosis:**
```bash
# Check network connectivity
ping -c 3 duckduckgo.com

# Check DNS resolution
nslookup duckduckgo.com

# Check firewall
sudo ufw status  # Linux
```

**Solutions:**

1. **Check internet connection:**
   ```bash
   ping -c 3 8.8.8.8
   ```

2. **Check DNS:**
   ```bash
   # Use Google DNS
   echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
   ```

3. **Check firewall:**
   ```bash
   # Allow outgoing connections
   sudo ufw allow out 80/tcp
   sudo ufw allow out 443/tcp
   ```

4. **Use proxy if needed:**
   ```bash
   PROXY_URL=socks5://127.0.0.1:9050
   ```

---

### Rate Limiting

**Symptom:** "Rate limited" errors

**Diagnosis:**
```bash
# Check error logs
/research-config errors view

# Check for 429 errors
grep -i "429" ~/.pi-research/logs/*.log
```

**Solutions:**

1. **Reduce request rate:**
   ```bash
   PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
   PI_RESEARCH_WORKER_CONCURRENCY=2
   ```

2. **Use longer timeouts:**
   ```bash
   PI_RESEARCH_SCRAPE_TIMEOUT_MS=30000
   ```

3. **Use Brave Search API:**
   ```bash
   BRAVE_SEARCH_API_KEY=your_api_key
   ```

4. **Wait before retrying:**
   ```bash
   # Wait a few minutes before next research
   ```

---

### Proxy Issues

**Symptom:** Proxy connection fails

**Diagnosis:**
```bash
# Check proxy configuration
echo $PROXY_URL

# Test proxy
curl -x $PROXY_URL https://duckduckgo.com
```

**Solutions:**

1. **Verify proxy is running:**
   ```bash
   # For Tor
   systemctl status tor

   # For SOCKS proxy
   netstat -tuln | grep 9050
   ```

2. **Test proxy connectivity:**
   ```bash
   curl -x socks5://127.0.0.1:9050 https://duckduckgo.com
   ```

3. **Remove proxy if not needed:**
   ```bash
   # Remove PROXY_URL from .env
   ```

---

## Testing Issues

### Tests Fail

**Symptom:** Unit or integration tests fail

**Diagnosis:**
```bash
# Run tests with output
npm run test:unit -- --reporter=verbose

# Check coverage
npm run test:coverage
```

**Solutions:**

1. **Update dependencies:**
   ```bash
   npm update
   npm install
   ```

2. **Clear test cache:**
   ```bash
   rm -rf node_modules/.vitest
   npm run test:unit
   ```

3. **Check TypeScript:**
   ```bash
   npm run type-check
   ```

4. **Check linting:**
   ```bash
   npm run lint
   ```

---

### Circular Dependency Errors

**Symptom:** "Circular dependency" errors during import

**Diagnosis:**
```bash
# Check for circular dependencies
npx madge --circular src/
```

**Solutions:**

1. **Check module structure:**
   ```bash
   # Visualize dependency graph
   npx madge --image deps.svg src/
   ```

2. **Refactor imports:**
   - Move logger to infrastructure layer
   - Eliminate circular imports
   - Use lazy imports where appropriate

3. **See architecture docs:**
   - [Architecture Decisions](../architecture/decisions.md)
   - [ADR-005: Circular Dependency Resolution](../architecture/decisions.md#adr-005-circular-dependency-resolution)

---

### Type Errors

**Symptom:** TypeScript type errors

**Diagnosis:**
```bash
npm run type-check
```

**Solutions:**

1. **Install missing types:**
   ```bash
   npm install --save-dev @types/node
   ```

2. **Check TypeScript version:**
   ```bash
   tsc --version  # Should be compatible with tsconfig.json
   ```

3. **Update tsconfig:**
   ```bash
   # Ensure strict mode is enabled
   # Check compiler options
   ```

---

## Getting Help

### Debug Mode

Enable verbose logging:

```bash
PI_RESEARCH_VERBOSE=1 pi
```

### Export Error Report

Export error report for analysis:

```bash
/research-config errors export error-report.json
```

### Check Logs

Check application logs:

```bash
# Linux/macOS
tail -f ~/.pi-research/logs/app.log

# Windows
type %USERPROFILE%\.pi-research\logs\app.log
```

### Report Issues

Create an issue on GitHub:

1. Run health check: `/health`
2. Export error report: `/research-config errors export`
3. Include environment details:
   - OS and version
   - Node.js version
   - pi-research version
   - Configuration (.env)

---

## Related

- [Deployment Guide](./deployment.md)
- [Performance Tuning](./performance-tuning.md)
- [Health Check API](../api/health-check.md)
- [Architecture Overview](../architecture/overview.md)

---

**Last Updated:** 2026-05-23