# Tor Support for pi-research

## Overview

pi-research includes optional Tor proxy support to avoid IP blocking by search engines like DuckDuckGo. When enabled, all SearXNG searches are routed through Tor's SOCKS5 proxy.

**Important:** Tor is **disabled by default**. It must be explicitly enabled via environment variables.

## Configuration

### Enable Tor

Set the `PI_RESEARCH_ENABLE_TOR` environment variable to `true`:

```bash
export PI_RESEARCH_ENABLE_TOR=true
```

### Tor Configuration Options

| Environment Variable | Default | Description |
|-------------------|----------|-------------|
| `PI_RESEARCH_ENABLE_TOR` | `false` | Enable Tor proxy for SearXNG searches |
| `PI_RESEARCH_TOR_SOCKS_PORT` | `9050` | Tor SOCKS5 proxy port |
| `PI_RESEARCH_TOR_CONTROL_PORT` | `9051` | Tor control port |
| `PI_RESEARCH_TOR_AUTO_START` | `false` | Automatically start Tor if not running |

## Installation

### macOS

```bash
brew install tor
```

### Linux/Ubuntu/Debian

```bash
sudo apt install tor
```

### Verify Installation

```bash
tor --version
```

You should see output like: `Tor version 0.4.8.10`

## Usage

### Option 1: Tor Already Running

If Tor is already running on your system (e.g., as a service), simply enable it:

```bash
export PI_RESEARCH_ENABLE_TOR=true
```

### Option 2: Auto-Start Tor

Let pi-research automatically start Tor for you:

```bash
export PI_RESEARCH_ENABLE_TOR=true
export PI_RESEARCH_TOR_AUTO_START=true
```

### Option 3: Custom Tor Port

If Tor is running on a custom port:

```bash
export PI_RESEARCH_ENABLE_TOR=true
export PI_RESEARCH_TOR_SOCKS_PORT=9150  # Example: Tor Browser's default port
```

## How It Works

When Tor is enabled:

1. **Tor Check**: pi-research verifies Tor is installed and accessible
2. **Configuration**: Generates a SearXNG settings file with Tor SOCKS5 proxy configuration
3. **Proxy Routing**: SearXNG container routes all outbound HTTP requests through `socks5://127.0.0.1:9050`
4. **IP Rotation**: Each Tor circuit provides a different exit IP, reducing rate-limiting

## Troubleshooting

### Tor Not Installed

**Error:**
```
Tor is enabled in configuration but not installed. 
Install Tor with: brew install tor (macOS) or apt install tor (Linux/Ubuntu)
```

**Fix:** Install Tor using the appropriate command for your system (see Installation section above).

### Tor Not Running

**Error:**
```
Tor is enabled but not running on port 9050. 
Start Tor manually or set PI_RESEARCH_TOR_AUTO_START=true.
```

**Fix:** Start Tor manually or set `PI_RESEARCH_TOR_AUTO_START=true`.

### Tor Connection Failed

**Error:**
```
Tor failed to bootstrap within 30 seconds
```

**Fix:**
- Check if your network allows Tor connections
- Verify Tor is not blocked by your firewall
- Try using a different Tor port
- Check Tor logs: `journalctl -u tor` (Linux) or `tail -f /usr/local/var/log/tor/tor.log` (macOS)

### Verify Tor is Working

Check if Tor is accessible:

```bash
# Check if Tor port is listening
netstat -an | grep 9050

# Or use curl to test Tor proxy
curl --socks5 127.0.0.1:9050 https://check.torproject.org
```

## Performance Considerations

- **Slower Searches**: Tor adds latency - expect 2-5 second delays
- **Reliability**: Some search engines may block Tor exit nodes
- **Rate Limiting**: Tor exit nodes are often rate-limited by search engines
- **Use Only When Needed**: Disable Tor for normal use; enable only when experiencing IP blocking

## Security Notes

- Tor provides anonymity for the **SearXNG instance**, not for your pi-research queries
- The pi-research tool itself still makes direct connections to the SearXNG container
- Only outbound requests from SearXNG to search engines go through Tor
- Consider using a dedicated Tor service for production use

## Disabling Tor

To disable Tor and use direct connections:

```bash
unset PI_RESEARCH_ENABLE_TOR
# or
export PI_RESEARCH_ENABLE_TOR=false
```

Then restart pi or trigger a new session.

## Advanced Configuration

### Tor with Systemd (Linux)

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

### Tor with launchd (macOS)

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
