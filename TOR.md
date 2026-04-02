# Proxy Support for pi-research

## Overview

pi-research includes optional proxy support to avoid IP blocking by search engines. When enabled, all SearXNG searches are routed through your configured proxy.

**Important:** Proxy support is **disabled by default**. It must be explicitly enabled via configuration.

## Configuration

### Enable Proxy

Set the `PROXY_URL` environment variable or add it to your `.env` file:

```bash
export PROXY_URL=socks5://127.0.0.1:9050
```

### Supported Proxy Types

#### SOCKS5 Proxy (Tor)
```bash
# Standard Tor
PROXY_URL=socks5://127.0.0.1:9050

# Tor Browser
PROXY_URL=socks5://127.0.0.1:9150
```

#### HTTP/HTTPS Proxy
```bash
# Simple HTTP proxy
PROXY_URL=http://proxy.example.com:8080

# HTTPS proxy
PROXY_URL=https://proxy.example.com:8443

# Authenticated proxy
PROXY_URL=http://username:password@proxy.example.com:8080
```

### Using Tor

#### Step 1: Install Tor

**macOS:**
```bash
brew install tor
```

**Linux/Ubuntu/Debian:**
```bash
sudo apt install tor
```

#### Step 2: Start Tor

Start Tor as a service or run it manually:

```bash
# Start Tor service
sudo systemctl start tor

# Or run manually (for testing)
tor
```

#### Step 3: Configure pi-research

```bash
export PROXY_URL=socks5://127.0.0.1:9050
pi
```

### Using Proxy Rotators

If you have a proxy rotator service (e.g., a service that rotates IPs automatically), simply use its endpoint:

```bash
export PROXY_URL=http://your-proxy-rotator.com:8080
pi
```

## Interactive Setup

Use the setup script for easy configuration:

```bash
./setup-config.sh
```

This script provides a menu to:
1. Set proxy URL
2. Clear proxy URL
3. View full `.env` file
4. Edit `.env` file directly

## Configuration File

For convenience, use a `.env` file:

```bash
# Copy the example
cp .env.example .env

# Edit the file
vim .env

# Source it
source .env
pi
```

Example `.env` file:
```bash
PROXY_URL=socks5://127.0.0.1:9050
```

## How It Works

When a proxy is configured:

1. **Proxy Configuration:** pi-research generates a SearXNG settings file with your proxy URL
2. **Proxy Routing:** SearXNG container routes all outbound HTTP requests through the configured proxy
3. **IP Rotation:** If using Tor or a proxy rotator, each request may use a different exit IP, reducing rate-limiting

## Troubleshooting

### Proxy Not Working

**Symptom:** Searches fail or timeout

**Check:**
1. Is your proxy running?
   ```bash
   # For Tor
   sudo systemctl status tor

   # Check if port is listening
   netstat -an | grep 9050
   ```

2. Is the proxy URL correct?
   ```bash
   # Test with curl
   curl --socks5 127.0.0.1:9050 https://check.torproject.org
   ```

3. Is Docker configured to reach the proxy?
   - For Tor on localhost: Use `socks5://127.0.0.1:9050` (Docker can reach host)
   - For remote proxies: Ensure firewall allows Docker connections

### Tor Not Installed

**Install Tor:**
```bash
# macOS
brew install tor

# Linux/Ubuntu
sudo apt install tor
```

### Connection Errors

**Error:** "Failed to configure proxy"

**Fix:**
1. Verify proxy is running
2. Check proxy URL format
3. Test proxy connectivity manually
4. Unset `PROXY_URL` to use direct connection

## Performance Considerations

- **Slower Searches:** Proxies add latency - expect 2-5 second delays
- **Reliability:** Some search engines may block Tor exit nodes or certain proxy IPs
- **Rate Limiting:** Proxy exit nodes may be rate-limited by search engines
- **Use Only When Needed:** Disable proxy for normal use; enable only when experiencing IP blocking

## Security Notes

- Proxies provide anonymity for the **SearXNG instance**, not for your pi-research queries
- The pi-research tool itself still makes direct connections to the SearXNG container
- Only outbound requests from SearXNG to search engines go through the proxy
- For Tor, consider running it as a dedicated service for production use
- Be cautious with public proxy services - they may log your requests

## Disabling Proxy

To disable the proxy and use direct connections:

```bash
unset PROXY_URL
# or edit .env and set: PROXY_URL=
```

Then restart pi or trigger a new session.

## Advanced Configuration

### Using Tor with Systemd (Linux)

Create a systemd service for Tor:

```ini
[Unit]
Description=Tor Anonymity Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/tor --SocksPort 9050 --ControlPort 9051
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save as `/etc/systemd/system/pi-research-tor.service` and run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pi-research-tor
sudo systemctl start pi-research-tor
```

### Using Tor with launchd (macOS)

Create a launchd plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>org.torproject.tor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/tor</string>
        <string>--SocksPort</string>
        <string>9050</string>
        <string>--ControlPort</string>
        <string>9051</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Save as `~/Library/LaunchAgents/org.torproject.tor.plist` and run:

```bash
launchctl load ~/Library/LaunchAgents/org.torproject.tor.plist
```

## Configuration Reference

| Environment Variable | Description | Default | Example |
|-------------------|-------------|----------|---------|
| `PROXY_URL` | Full proxy URL | undefined (disabled) | `socks5://127.0.0.1:9050` |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | Researcher timeout | 60000 (60s) | 120000 |
| `PI_RESEARCH_FLASH_TIMEOUT_MS` | Flash timeout | 1000 (1s) | 500 |

## Quick Reference

**Enable Tor:**
```bash
export PROXY_URL=socks5://127.0.0.1:9050
pi
```

**Enable HTTP Proxy:**
```bash
export PROXY_URL=http://proxy.example.com:8080
pi
```

**Disable Proxy:**
```bash
unset PROXY_URL
pi
```

**Check Proxy Working:**
```bash
# For Tor
curl --socks5 127.0.0.1:9050 https://check.torproject.org

# For HTTP proxy
curl -x http://127.0.0.1:8080 https://httpbin.org/ip
```
