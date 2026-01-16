# Agent-iOS Specification

A CLI + daemon that provides LLM-friendly automation for iOS apps, inspired by [agent-browser](https://github.com/vercel-labs/agent-browser).

## 1. Goal

Expose a stable, JSON-first automation API for iOS apps (Simulator) so an LLM receives accessibility snapshots and can perform atomic UI actions (tap, type, swipe, screenshot) without human interpretation.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM Agent / User                                           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│  CLI (agent-ios)                                            │
│  - Command parsing, JSON output                             │
│  - Connects to daemon via socket                            │
└────────────────┬────────────────────────────────────────────┘
                 │ Unix socket (macOS) / TCP (fallback)
                 v
┌─────────────────────────────────────────────────────────────┐
│  Node.js Daemon                                             │
│  - Session & ref management                                 │
│  - Snapshot parsing & formatting                            │
│  - Simulator lifecycle (simctl)                             │
│  - WDA lifecycle management                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTP (localhost:8100)
                 v
┌─────────────────────────────────────────────────────────────┐
│  WebDriverAgent (WDA)                                       │
│  - XCUITest running as HTTP server                          │
│  - Accessibility tree extraction                            │
│  - Element interaction (tap/type/swipe)                     │
└────────────────┬────────────────────────────────────────────┘
                 │ XCTest/Accessibility APIs
                 v
┌─────────────────────────────────────────────────────────────┐
│  iOS Simulator + App Under Test                             │
└─────────────────────────────────────────────────────────────┘
```

### Why WebDriverAgent?

The original spec proposed a custom "XCTest Bridge" but this has a fundamental problem: XCUITest is designed to run tests and exit, not act as a persistent daemon.

WebDriverAgent (created by Facebook, maintained by Appium) solves this by being an XCUITest that runs as an HTTP server. It provides:
- Persistent session (no restart overhead between commands)
- REST API for all interactions
- Accessibility tree via `/source` endpoint
- Battle-tested across iOS versions

This is analogous to how agent-browser uses Playwright as its browser automation layer.

---

## 3. Core Components

### 3.1 CLI (`agent-ios`)

Stateless command-line interface that communicates with the daemon.

```bash
agent-ios <command> [options]
```

**Commands:**

| Command | Description |
|---------|-------------|
| `launch <bundle-id>` | Launch app on simulator |
| `terminate <bundle-id>` | Terminate app |
| `snapshot` | Get accessibility tree as JSON |
| `screenshot [--out file]` | Capture PNG screenshot |
| `tap <ref>` | Tap element by ref |
| `type <ref> <text>` | Type text into element |
| `clear <ref>` | Clear text field |
| `swipe <ref> <direction>` | Swipe on element (up/down/left/right) |
| `wait <ref> [--timeout ms]` | Wait for element to appear |
| `install <app-path>` | Install app on simulator |
| `list-sims` | List available simulators |
| `start-session [--sim name]` | Start daemon + WDA session |
| `stop-session` | Stop daemon and WDA |
| `status` | Check daemon/WDA health |

**Output format:** All commands return JSON to stdout:

```json
{
  "success": true,
  "data": { ... }
}
```

```json
{
  "success": false,
  "error": "Element @e5 not found. Run 'snapshot' to get updated refs."
}
```

### 3.2 Node.js Daemon

Persistent process that maintains state and coordinates between CLI and WDA.

**Responsibilities:**

1. **Socket server** - Listen for CLI commands on Unix socket (`/tmp/agent-ios-{session}.sock`)
2. **Session management** - Track active simulator, WDA process, current app
3. **Ref mapping** - Maintain `@eN → element query` mappings
4. **Snapshot transformation** - Convert WDA XML to clean JSON schema
5. **Simulator control** - Boot/shutdown via `xcrun simctl`
6. **WDA lifecycle** - Start/stop/restart WDA, health checks

**Session persistence:**
- Daemon stays alive between commands (like agent-browser)
- PID file at `/tmp/agent-ios-{session}.pid`
- Auto-cleanup on SIGTERM/SIGINT

### 3.3 WebDriverAgent Integration

WDA provides the low-level automation. The daemon wraps it with a cleaner interface.

**WDA endpoints used:**

| Our Action | WDA Endpoint |
|------------|--------------|
| snapshot | `GET /source?format=json` |
| screenshot | `GET /screenshot` |
| tap | `POST /session/{sid}/element/{eid}/click` |
| type | `POST /session/{sid}/element/{eid}/value` |
| clear | `POST /session/{sid}/element/{eid}/clear` |
| find element | `POST /session/{sid}/element` |
| launch app | `POST /session/{sid}/wda/apps/launch` |
| terminate app | `POST /session/{sid}/wda/apps/terminate` |
| alert handling | `GET /session/{sid}/alert/text`, `POST .../accept` |

**WDA startup:**
```bash
# Build and run WDA on simulator
xcodebuild -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  test
```

The daemon manages this process and monitors its health.

---

## 4. Snapshot Schema

The daemon transforms WDA's XML source into a clean, LLM-friendly JSON format.

```json
{
  "app": "com.example.App",
  "timestamp": "2025-01-16T10:12:00Z",
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
      "children": ["@e2", "@e3"]
    },
    {
      "ref": "@e2",
      "type": "XCUIElementTypeStaticText",
      "label": "Log in",
      "identifier": null,
      "value": null,
      "frame": {"x": 140, "y": 792, "w": 72, "h": 24},
      "enabled": true,
      "visible": true,
      "children": []
    }
  ],
  "tree": "@e0",
  "refMap": {
    "@e1": {"type": "XCUIElementTypeButton", "label": "Log in", "identifier": "loginButton"},
    "@e2": {"type": "XCUIElementTypeStaticText", "label": "Log in"}
  }
}
```

**Notes:**
- `ref`: Opaque reference for use in subsequent commands
- `refMap`: Summary for quick LLM reference (role + label, like agent-browser)
- `tree`: Root element ref
- Flat `elements` array with `children` refs (avoids deep nesting)

---

## 5. Element Referencing

### Ref Generation

When generating a snapshot, assign incremental refs (`@e0`, `@e1`, ...) and store resolution info:

```typescript
interface RefEntry {
  type: string;           // XCUIElementTypeButton
  identifier?: string;    // accessibilityIdentifier (most stable)
  label?: string;         // accessibilityLabel
  index: number;          // index among siblings of same type
  xpath: string;          // fallback: full XPath from WDA
}
```

### Ref Resolution

When executing an action with `@eN`:

1. Look up RefEntry from session map
2. Build WDA query in priority order:
   - If `identifier` exists: `{using: 'accessibility id', value: identifier}`
   - Else if `label` exists: `{using: 'predicate string', value: "type == 'X' AND label == 'Y'"}`
   - Else: Use stored XPath
3. Execute WDA find element request
4. If element not found or multiple matches, return helpful error

### Stale Ref Handling

If a ref fails to resolve:
```json
{
  "success": false,
  "error": "Element @e5 not found. The UI may have changed. Run 'snapshot' to get updated refs.",
  "suggestion": "snapshot"
}
```

---

## 6. Alert Handling

iOS frequently shows system alerts (permissions, etc.). The daemon should detect and surface these.

**On every action:**
1. Check `GET /session/{sid}/alert/text`
2. If alert present, return:
```json
{
  "success": false,
  "error": "System alert is blocking: \"App wants to access your location\"",
  "alert": {
    "text": "App wants to access your location",
    "buttons": ["Allow Once", "Allow While Using App", "Don't Allow"]
  },
  "suggestion": "Use 'alert-accept' or 'alert-dismiss' to handle"
}
```

**Alert commands:**
- `agent-ios alert-accept` - Tap default/accept button
- `agent-ios alert-dismiss` - Tap cancel/dismiss button
- `agent-ios alert-button <text>` - Tap specific button by label

---

## 7. Error Translation

Convert WDA errors to actionable LLM guidance (like agent-browser's `toAIFriendlyError`):

| WDA Error | User-Friendly Message |
|-----------|----------------------|
| Element not found | "Element @eN not found. Run 'snapshot' to get updated refs." |
| Element not visible | "Element @eN exists but is not visible. May need to scroll." |
| Element not interactable | "Element @eN is disabled and cannot be interacted with." |
| Multiple elements found | "Multiple elements match @eN. Run 'snapshot' for more specific refs." |
| Session invalid | "WDA session expired. Run 'start-session' to reconnect." |
| App crashed | "App com.example.App crashed. Run 'launch' to restart." |

---

## 8. Development Plan

### Phase 1: Foundation

1. Set up Node.js project with TypeScript
2. Implement daemon socket server (Unix socket + TCP fallback)
3. Implement CLI that connects to daemon
4. Add simulator management via `simctl` (boot, shutdown, list)

### Phase 2: WDA Integration

5. Bundle or document WDA setup
6. Implement WDA process management (start, stop, health check)
7. Implement basic WDA HTTP client
8. Test basic flow: start session → get source → screenshot

### Phase 3: Snapshot & Refs

9. Parse WDA XML source into JSON schema
10. Implement ref generation and storage
11. Implement ref resolution for actions
12. Add refMap to snapshot output

### Phase 4: Actions

13. Implement tap, type, clear, swipe via WDA
14. Add wait command with polling
15. Add alert detection and handling
16. Implement error translation layer

### Phase 5: Polish

17. Add install/launch/terminate commands
18. Add screenshot with file output
19. Add status/health command
20. Error handling, edge cases, logging
21. Documentation and examples

---

## 9. Technical Decisions

### Why Node.js for daemon?

- Easy HTTP client for WDA
- Good process management
- Matches agent-browser's approach
- Fast prototyping

Could later port to Rust/Go for single binary distribution.

### Why Unix socket?

- Fast local IPC (no TCP overhead)
- Natural session isolation via socket path
- Fallback to TCP for compatibility

### Why transform WDA XML?

WDA's raw XML is verbose and hard for LLMs to parse. Our JSON schema:
- Adds opaque refs (cleaner than XPath in prompts)
- Flattens structure (avoids deep nesting)
- Includes only relevant attributes
- Provides refMap summary

### Why not use Appium?

Appium adds another layer (Appium server → WDA). For our use case, talking directly to WDA is simpler and has less overhead. However, Appium could be supported as an alternative backend later.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **WDA setup complexity** | Provide setup script, document prerequisites, consider bundling pre-built WDA |
| **WDA crashes/hangs** | Health checks, auto-restart, timeout on all requests |
| **Incomplete accessibility** | Document that apps need proper accessibilityIdentifier/Label; can't fix poorly instrumented apps |
| **iOS version compatibility** | Test matrix, document supported versions, WDA generally tracks iOS well |
| **Slow snapshot for complex UIs** | Add `--depth` flag to limit tree depth, cache when UI unchanged |

---

## 11. Prerequisites

**Required:**
- macOS (for iOS Simulator)
- Xcode + Command Line Tools
- Node.js 18+
- WebDriverAgent (will document setup or provide script)

**For app testing:**
- Built `.app` bundle for simulator
- Or App Store app (limited - must be installed via Xcode)

---

## 12. Example Session

```bash
# Start session with iPhone 15 simulator
$ agent-ios start-session --sim "iPhone 15"
{"success": true, "data": {"simulator": "iPhone 15", "udid": "XXXX-XXXX"}}

# Install and launch app
$ agent-ios install ./MyApp.app
{"success": true}

$ agent-ios launch com.example.MyApp
{"success": true}

# Get snapshot
$ agent-ios snapshot
{
  "success": true,
  "data": {
    "app": "com.example.MyApp",
    "elements": [...],
    "refMap": {
      "@e1": {"type": "XCUIElementTypeButton", "label": "Log in"},
      "@e5": {"type": "XCUIElementTypeTextField", "label": "Email"}
    }
  }
}

# Type into email field
$ agent-ios type @e5 "user@example.com"
{"success": true}

# Tap login button
$ agent-ios tap @e1
{"success": true}

# Handle permission alert
$ agent-ios tap @e10
{
  "success": false,
  "error": "System alert is blocking: \"Allow notifications?\"",
  "alert": {"text": "Allow notifications?", "buttons": ["Allow", "Don't Allow"]}
}

$ agent-ios alert-button "Allow"
{"success": true}

# Stop session
$ agent-ios stop-session
{"success": true}
```

---

## 13. Future Enhancements

- **Real device support** - WDA supports real devices with some setup
- **Multiple simulators** - Named sessions for parallel testing
- **Video recording** - Via `simctl io recordVideo`
- **Network mocking** - Proxy layer for API stubbing
- **Visual diff** - Compare screenshots for UI regression
- **Appium backend** - Alternative to direct WDA for teams already using Appium
