# IPv6 Rotation Removal Summary

## Date
April 4, 2026

## What Was Removed

### Files Deleted
- `src/infrastructure/network-manager.ts` (310 lines)
- `test/unit/infrastructure/network-manager.test.ts`
- `test/unit/infrastructure/state-manager.test.ts`

### Code Removed from Files

#### `src/infrastructure/searxng-manager.ts`
- Removed `NetworkManager` import
- Removed `networkManager` and `containerStartTime` properties
- Removed `enableIPv6Rotation` and `maxUptimeMinutes` config options
- Removed `ipv6Address` and `ipv6Enabled` from `SearxngContainerInfo` interface
- Removed `ipv6Address` and `ipv6Enabled` from `SearxngStatus` interface
- Removed IPv6 network initialization code from `startSingleton()`
- Removed IPv6 network initialization code from `start()`
- Removed IPv6 network attachment/reconnection logic from `acquire()`
- Removed IPv6-only network enforcement (bridge disconnection)
- Removed IPv6 network cleanup code from `stopSingleton()`
- Removed IPv6 network configuration from container creation
- Removed uptime-based container restart logic from `startHeartbeat()`
- Removed container restart notification messages

#### `src/infrastructure/state-manager.ts`
- Removed `ipv6Address` field from `SingletonState` interface
- Removed `ipv6Enabled` field from `SingletonState` interface
- Removed type guard checks for `ipv6Address` and `ipv6Enabled`
- Removed `ipv6Address` and `ipv6Enabled` from default state

#### `test/README.md`
- Removed reference to `infrastructure/network-manager.ts`

## What Remains (Intentionally Kept)

### `config/limiter.toml`
This file contains IPv6 settings for **SearXNG's built-in bot detection**, NOT the removed rotation feature:
- `ipv6_prefix = 48` - Bot detection network prefix grouping
- `fe80::/10` - IPv6 link-local address whitelist

**These are legitimate and should be kept.** They help SearXNG properly handle IPv6 connections without triggering false positives.

### `TOR.md`
Contains reference to Tor's IP rotation capability in the context of how Tor works. This is legitimate documentation and should be kept.

## Verification Results

### Code Cleanliness
- ✅ No `NetworkManager` references in source code
- ✅ No `enableIPv6Rotation` references in source code
- ✅ No `maxUptimeMinutes` references in source code
- ✅ No `ipv6Address` references in source code (except limiter.toml)
- ✅ No `ipv6Enabled` references in source code (except limiter.toml)
- ✅ No `containerStartTime` tracking
- ✅ No uptime-based restart logic
- ✅ No environment variable references (`SEARXNG_IPV6_ROTATION`, `SEARXNG_MAX_UPTIME`)

### Testing
- ✅ All 37 test files pass
- ✅ 1,164 tests pass, 1 skipped
- ✅ No test failures related to IPv6 removal

### Linting
- ✅ No linting errors

### Documentation
- ✅ No IPv6 rotation documentation remains (except TOR.md context)

## Impact

### Removed Complexity
- ~342 lines of code removed from `searxng-manager.ts`
- ~21 lines removed from `state-manager.ts`
- ~310 lines removed from `network-manager.ts`
- Total: **~673 lines of complex networking code removed**

### Improved Stability
- No more automatic container restarts every 90 minutes
- No more service interruptions during research sessions
- No more network management overhead
- No more orphaned Docker networks

### Recommended Alternative
For users needing IP rotation/anonymity:
- Use **Tor** (already supported via `PROXY_URL` env var)
- See `TOR.md` for setup instructions

## Conclusion

IPv6 rotation has been completely and cleanly removed from the pi-research codebase. All traces of the implementation, testing, and configuration have been eliminated. The remaining IPv6 references are legitimate (SearXNG bot detection configuration) and should be kept.

Users should use Tor for IP rotation/anonymity needs, which is simpler, more reliable, and actually works.
