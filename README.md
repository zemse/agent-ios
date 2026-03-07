# agent-ios

CLI for LLM-friendly iOS automation. Works with both Simulators and physical devices. Get accessibility snapshots, tap elements by reference, type text, and more.

[![npm version](https://img.shields.io/npm/v/agent-ios.svg)](https://www.npmjs.com/package/agent-ios)

## Install

```bash
npm install -g agent-ios
agent-ios setup  # Clones WebDriverAgent to ~/WebDriverAgent
```

### Requirements

- macOS with Xcode + Command Line Tools
- Node.js 18+

## Quick Start

```bash
# Simulator
agent-ios start-session --sim "iPhone 15"  # Boot simulator + start WDA
agent-ios snapshot                          # Get accessibility tree with refs
agent-ios tap @e5                           # Tap element by ref
agent-ios type @e10 "Hello World"           # Type text into element
agent-ios stop-session                      # Stop session

# Physical device (connected via USB)
agent-ios list-devices                           # See connected devices
agent-ios start-session --device "G's iPhone"    # Start WDA on real device
```

## Commands

### Session

```bash
agent-ios start-session [--sim <name>]       # Boot simulator and start WDA
agent-ios start-session --device <name|id>   # Start WDA on physical device
agent-ios stop-session                       # Stop WDA and daemon
agent-ios status                             # Check daemon/target/WDA status
agent-ios list-sims                          # List available simulators
agent-ios list-devices                       # List connected physical devices
```

### App Management

```bash
agent-ios install <path>       # Install .app bundle on target (simulator or device)
agent-ios launch <bundle-id>   # Launch app by bundle ID
agent-ios terminate <bundle-id> # Terminate app
```

### Automation

```bash
agent-ios snapshot                     # Get accessibility tree as JSON with refs
agent-ios screenshot [--out <file>]    # Take screenshot (PNG, base64 if no file)
agent-ios tap <ref>                    # Tap element (e.g., @e5)
agent-ios type <ref> <text>            # Type text into element
agent-ios clear <ref>                  # Clear text field
agent-ios swipe <ref> <dir>            # Swipe on element (up/down/left/right)
agent-ios wait <ref> [--timeout <ms>]  # Wait for element (default 10s)
```

### Alerts

```bash
agent-ios alert-accept       # Accept current alert
agent-ios alert-dismiss      # Dismiss current alert
agent-ios alert-button <text> # Tap specific alert button
```

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
      "frame": { "x": 12, "y": 780, "w": 351, "h": 48 },
      "enabled": true,
      "visible": true,
      "children": ["@e2"]
    }
  ],
  "tree": "@e0",
  "refMap": {
    "@e1": {
      "type": "XCUIElementTypeButton",
      "label": "Log in",
      "identifier": "loginButton"
    }
  }
}
```

- `ref`: Opaque reference for use in commands (`tap @e1`)
- `refMap`: Quick lookup of ref to type/label/identifier
- `tree`: Root element ref
- Elements are flat with `children` refs (no deep nesting)

## Environment Variables

| Variable            | Default            | Description                          |
| ------------------- | ------------------ | ------------------------------------ |
| `WDA_PATH`          | `~/WebDriverAgent` | Path to WebDriverAgent               |
| `WDA_PORT`          | `8100`             | WDA HTTP port                        |
| `IOS_AGENT_SESSION` | `default`          | Session name (for multiple sessions) |

## Architecture

```
CLI (agent-ios) → Unix Socket → Node.js Daemon → HTTP → WebDriverAgent → iOS Simulator / Device
```

The daemon manages WDA lifecycle and maintains element ref mappings between snapshots. For physical devices, `xcrun devicectl` is used for device discovery and app installation, while WDA is built with `platform=iOS` instead of `platform=iOS Simulator`.

## Troubleshooting

**WDA build slow?** First build compiles WebDriverAgent. Watch progress:

```bash
tail -f /tmp/agent-ios-wda.log
```

**Element not found?** UI changed since last snapshot. Run `snapshot` again to get fresh refs.

**Simulator not booting?** Ensure Xcode CLI tools are set:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

**Device not showing up?** Ensure it's connected via USB, unlocked, and trusted. Check with:

```bash
xcrun devicectl list devices
```

**WDA fails on device?** You may need to configure code signing for WebDriverAgent. Open `WebDriverAgent.xcodeproj` in Xcode, select the `WebDriverAgentRunner` target, and set a valid development team.

## License

MIT
