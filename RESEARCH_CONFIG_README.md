# Research Configuration Command

The `/research-config` command is your single entry point for managing all pi-research configuration, health monitoring, error tracking, and system diagnostics.

## Quick Start

```bash
# Open interactive menu (recommended for first-time users)
/research-config

# Quick health check
/research-config health run

# Edit settings interactively
/research-config settings edit

# View error report
/research-config errors view
```

## Overview

The `/research-config` command consolidates all management functions into a single, hierarchical interface:

- **Health Management** - Run health checks, view history, clear cache
- **Error Reporting** - View errors, export reports, clear history
- **Knowledge Store** - Check status, migrate data, manage cache
- **System Settings** - View, edit, and reset configuration
- **Metrics & Monitoring** - View system performance metrics

## Usage Patterns

### Pattern 1: Interactive Mode (Recommended)

No arguments opens an interactive TUI menu:

```bash
/research-config
```

**Navigation:**
- `↑↓` - Navigate menu items
- `Enter` - Select item / Execute action
- `Esc` - Go back / Exit menu
- Status messages show action results

### Pattern 2: Section Access

Access a specific section's default action:

```bash
/research-config health      # Health management
/research-config errors      # Error reporting
/research-config knowledge   # Knowledge store
/research-config settings    # System settings
/research-config metrics     # Metrics & monitoring
```

### Pattern 3: Direct Actions

Execute a specific action directly:

```bash
/research-config health run
/research-config health clear
/research-config health history

/research-config errors view
/research-config errors export
/research-config errors clear

/research-config knowledge status
/research-config knowledge migrate drop
/research-config knowledge clear

/research-config settings view
/research-config settings edit
/research-config settings reset

/research-config metrics view
```

## Sections

### Health Management

Monitor system health and diagnose issues.

**Actions:**
- `run` - Run all health checks
- `history` - View recent health check history (last 15)
- `summary` - View health statistics summary
- `clear` - Clear health check cache (forces re-run)

**Examples:**
```bash
/research-config health run
/research-config health history
/research-config health summary
/research-config health clear
```

**What it checks:**
- Browser Pool (Camoufox availability)
- Knowledge Store (embedder status, test embedding)
- GPU Lock (GPU ownership status)
- ErrorTracker (error count thresholds)

### Error Reporting

View and manage error reports with pattern recognition.

**Actions:**
- `view` - View comprehensive error report
- `patterns` - View error patterns summary (table format)
- `export` - Export errors to JSON file
- `export <path>` - Export to specific path
- `clear` - Clear all error history

**Examples:**
```bash
/research-config errors view
/research-config errors patterns
/research-config errors export
/research-config errors export ~/errors.json
/research-config errors clear
```

**Error Report Features:**
- Total error count
- Unique error patterns
- Pattern frequency analysis
- First/last seen timestamps
- Context information (researchId, mode, component, operation)

### Knowledge Store

Manage the persistent knowledge store and embedding models.

**Actions:**
- `status` - View knowledge store status and configuration
- `count` - Show number of stored entries
- `migrate <strategy>` - Migrate knowledge store data
- `clear` - Delete all knowledge store data

**Migration Strategies:**
- `drop` - Delete and recreate table (data loss, fast)
- `re-embed` - Re-embed all documents with new model (preserves data, slower)
- `continue` - Keep existing data, use new model for new documents (mixed quality)

**Examples:**
```bash
/research-config knowledge status
/research-config knowledge count
/research-config knowledge migrate drop
/research-config knowledge migrate re-embed
/research-config knowledge migrate continue
/research-config knowledge clear
```

**Important Notes:**
- Changing models clears the knowledge DB (dimensional incompatibility)
- Migration requires reload to take effect
- Use `re-embed` to preserve data when dimensions are compatible
- `continue` mode may result in mixed search quality

### System Settings

View and modify pi-research configuration.

**Actions:**
- `view` - View current configuration (display format)
- `edit` - Open interactive configuration editor (sophisticated TUI)
- `reset` - Reset all settings to defaults (requires reload)

**Configuration Editor Features:**
- Interactive arrow-key navigation
- Real-time value adjustment
- Toggle booleans
- Cycle through options
- Model cache detection
- Knowledge store integration
- Validation before save
- Automatic persistence to .env file

**Examples:**
```bash
/research-config settings view
/research-config settings edit
/research-config settings reset
```

**Configurable Settings:**
- Max Concurrent Researchers (1-5)
- Default Research Depth (0-3)
- Max Scrape Batches (0=unlimited, 1-99)
- Worker Threads (1-16)
- Knowledge Store (enabled/disabled)
- Embedding Model (cycle through available models)
- Embedding Device (webgpu/cpu)
- Cache TTL (1-365 days)
- Researcher Timeout (3-30 minutes)
- Clear DB Cache (action button)

### Metrics & Monitoring

View system performance metrics.

**Actions:**
- `view` - View current system metrics

**Examples:**
```bash
/research-config metrics view
```

**Available Metrics:**
- Health check durations
- Knowledge store operations
- Search/query statistics
- Error counts by component
- Custom application metrics

## Backward Compatibility

All old commands still work as aliases:

| Old Command | New Equivalent |
|------------|----------------|
| `/health` | `/research-config health run` |
| `/health-clear` | `/research-config health clear` |
| `/health-history` | `/research-config health history` |
| `/errors` | `/research-config errors view` |
| `/errors-clear` | `/research-config errors clear` |
| `/errors-export` | `/research-config errors export` |
| `/knowledge-migrate <strategy>` | `/research-config knowledge migrate <strategy>` |

The old commands show their new equivalent in the description for easy migration.

## Keyboard Shortcuts (Interactive Mode)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate up/down |
| `Enter` | Select / Execute |
| `Esc` | Go back / Exit |
| `←` / `→` | Adjust values (in settings editor) |
| `Ctrl+C` | Force exit |

## Common Workflows

### Daily Health Check
```bash
# Quick health check
/research-config health run

# Or use interactive mode
/research-config → Health Management → Run Health Check
```

### Troubleshooting Errors
```bash
# View error patterns
/research-config errors patterns

# Export full report for analysis
/research-config errors export ~/research-errors.json

# Clear after fixing issues
/research-config errors clear
```

### Changing Embedding Model
```bash
# Check current status
/research-config knowledge status

# Edit settings to change model
/research-config settings edit
# Navigate to "Embed Model" and cycle with ←/→
# Save with Enter

# Note: Model change clears DB, consider migration:
/research-config knowledge migrate re-embed
```

### Performance Tuning
```bash
# View current settings
/research-config settings view

# Edit interactively
/research-config settings edit
# Adjust Max Concurrent Researchers, Worker Threads, etc.
# Save with Enter

# Check system metrics
/research-config metrics view
```

### System Diagnostics
```bash
# Run full diagnostics
/research-config health run
/research-config errors view
/research-config knowledge status
/research-config metrics view

# Or use interactive mode to navigate all sections
/research-config
```

## Configuration File

Settings are persisted to `.env` in the pi-research extension directory:

```
~/.local/share/pi/extensions/lincoln504-pi-research/.env
```

The settings editor automatically updates this file. You can also edit it manually:

```bash
# View config file location
/research-config settings view

# Edit file directly (advanced)
nano ~/.local/share/pi/extensions/lincoln504-pi-research/.env
```

## Error Messages and Solutions

### "Health check cache cleared"
**Solution:** This is informational. Cache cleared successfully. Next check will run fresh.

### "Knowledge store migration complete: drop"
**Solution:** Migration completed. All previous data was deleted. Database recreated with new model.

### "Settings reset to defaults (reload required)"
**Solution:** Settings have been reset. Reload pi or restart research session for changes to take effect.

### "Configuration updated and saved"
**Solution:** Settings successfully saved to .env file. Changes take effect immediately for most settings; some may require reload.

### "Invalid config: <error message>"
**Solution:** Configuration validation failed. Check the error message and adjust values. Use `/research-config settings edit` for interactive validation.

### "Knowledge store is not ready"
**Solution:** Knowledge store not initialized. This is normal if disabled or first run. Enable in settings or initialize knowledge store.

## Tips and Best Practices

1. **Use Interactive Mode for Exploration:** New users should start with `/research-config` to explore available options.

2. **Use Direct Actions for Automation:** Scripts and automation should use direct action syntax like `/research-config health run`.

3. **Check Health Before Research:** Run `/research-config health run` before important research sessions.

4. **Review Errors Regularly:** Check `/research-config errors view` periodically to identify recurring issues.

5. **Export Error Reports:** Use `/research-config errors export` before clearing errors for analysis.

6. **Careful with Model Changes:** Changing embedding models clears the knowledge DB. Consider using `re-embed` migration to preserve data.

7. **Monitor Knowledge Store Size:** Use `/research-config knowledge count` to monitor storage usage.

8. **Backup Configuration:** The .env file is your configuration backup. Copy it before major changes.

9. **Use TTL for Cache Management:** Set appropriate Cache TTL in settings to automatically manage knowledge store size.

10. **Check Metrics for Performance:** Use `/research-config metrics view` to identify performance bottlenecks.

## Getting Help

- **Inline Help:** Each menu item shows description and available actions
- **Command Descriptions:** Use `?` or help in your pi client to see command descriptions
- **Error Messages:** Error messages include suggested solutions
- **Documentation:** See `RESEARCH_CONFIG_IMPLEMENTATION.md` for detailed technical documentation

## Advanced Usage

### Custom Error Export Location
```bash
# Export to custom location
/research-config errors export ~/my-research-errors/errors-$(date +%Y%m%d).json
```

### Batch Operations
```bash
# Run health, check errors, view metrics
/research-config health run && /research-config errors view && /research-config metrics view
```

### Automated Monitoring
```bash
# Periodic health check (add to cron)
*/30 * * * * /research-config health run > /tmp/pi-research-health.log
```

### Configuration Reset with Backup
```bash
# Backup current config
cp ~/.local/share/pi/extensions/lincoln504-pi-research/.env ~/.backup/pi-research.env

# Reset to defaults
/research-config settings reset

# Restore if needed
cp ~/.backup/pi-research.env ~/.local/share/pi/extensions/lincoln504-pi-research/.env
```

---

**Command:** `/research-config`  
**Type:** Management & Configuration  
**Aliases:** `/health`, `/health-clear`, `/health-history`, `/errors`, `/errors-clear`, `/errors-export`, `/knowledge-migrate`  
**Interactive:** Yes (TUI menu)  
**Direct Actions:** Yes (section + action syntax)