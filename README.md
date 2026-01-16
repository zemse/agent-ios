# agent-ios

CLI for LLM-friendly iOS Simulator automation. Get accessibility snapshots, tap elements by reference, type text, and more.

## Requirements

- macOS with Xcode + Command Line Tools
- Node.js 18+
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) cloned to `~/WebDriverAgent`

```bash
git clone https://github.com/appium/WebDriverAgent.git ~/WebDriverAgent
```

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# List available simulators
./bin/agent-ios list-sims

# Start a session (boots simulator + starts WebDriverAgent)
./bin/agent-ios start-session --sim "iPhone 15"

# Get accessibility snapshot with element refs
./bin/agent-ios snapshot

# Interact with elements using refs from snapshot
./bin/agent-ios tap @e5
./bin/agent-ios type @e10 "Hello World"

# Stop session
./bin/agent-ios stop-session
```

## Commands

### Session

| Command | Description |
|---------|-------------|
| `start-session [--sim <name>]` | Boot simulator and start WDA |
| `stop-session` | Stop WDA and daemon |
| `status` | Check daemon/simulator/WDA status |
| `list-sims` | List available simulators |

### App Management

| Command | Description |
|---------|-------------|
| `install <path>` | Install .app bundle on simulator |
| `launch <bundle-id>` | Launch app by bundle ID |
| `terminate <bundle-id>` | Terminate app |

### Automation

| Command | Description |
|---------|-------------|
| `snapshot` | Get accessibility tree as JSON with refs |
| `screenshot [--out <file>]` | Take screenshot (PNG, base64 if no file) |
| `tap <ref>` | Tap element (e.g., `@e5`) |
| `type <ref> <text>` | Type text into element |
| `clear <ref>` | Clear text field |
| `swipe <ref> <dir>` | Swipe on element (up/down/left/right) |
| `wait <ref> [--timeout <ms>]` | Wait for element (default 10s) |

### Alerts

| Command | Description |
|---------|-------------|
| `alert-accept` | Accept current alert |
| `alert-dismiss` | Dismiss current alert |
| `alert-button <text>` | Tap specific alert button |

## Output Format

All commands return JSON:

```json
{"success": true, "data": {...}}
{"success": false, "error": "..."}
```

## Snapshot Schema

```json
{
  "timestamp": "2025-01-16T10:00:00Z",
  "elements": [
    {
      "ref": "@e1",
      "type": "XCUIElementTypeButton",
      "label": "Log in",
      "identifier": "loginButton",
      "value": null,
      "frame": {"x": 12, "y": 780, "w": 351, "h": 48},
      "enabled": true,
      "visible": true,
      "children": ["@e2"]
    }
  ],
  "tree": "@e0",
  "refMap": {
    "@e1": {"type": "XCUIElementTypeButton", "label": "Log in", "identifier": "loginButton"}
  }
}
```

- `ref`: Opaque reference for use in commands (`tap @e1`)
- `refMap`: Quick lookup of ref → type/label/identifier
- `tree`: Root element ref
- Elements are flat with `children` refs (no deep nesting)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WDA_PATH` | `~/WebDriverAgent` | Path to WebDriverAgent |
| `WDA_PORT` | `8100` | WDA HTTP port |
| `IOS_AGENT_SESSION` | `default` | Session name (for multiple sessions) |

## Architecture

```
CLI (agent-ios) → Unix Socket → Node.js Daemon → HTTP → WebDriverAgent → iOS Simulator
```

The daemon manages WDA lifecycle and maintains element ref mappings between snapshots.

## Example: Automate Safari

```bash
./bin/agent-ios start-session --sim "iPhone 15"
./bin/agent-ios launch com.apple.mobilesafari
./bin/agent-ios snapshot > snapshot.json
# Find URL bar ref from snapshot, e.g., @e15
./bin/agent-ios tap @e15
./bin/agent-ios type @e15 "https://example.com"
./bin/agent-ios tap @e20  # Go button
./bin/agent-ios screenshot --out page.png
./bin/agent-ios stop-session
```

## Troubleshooting

**WDA build slow?** First build compiles WebDriverAgent (~1-2 min). Watch progress:
```bash
tail -f /tmp/agent-ios-wda.log
```

**Element not found?** UI changed since last snapshot. Run `snapshot` again to get fresh refs.

**Simulator not booting?** Ensure Xcode CLI tools are set:
```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

## License

MIT
