# iOS-Agent Specification

## 1. Goal

Provide a CLI + daemon that exposes a stable, JSON-first automation API for iOS apps (Simulator) so an LLM receives accessibility snapshots and can perform atomic UI actions (tap, type, swipe, screenshot, snapshot-json) without human interpretation.

---

## 2. High-Level Architecture

```
+-------------------+        +--------------------+        +-------------------+
|   LLM Agent       | <----> |  Control Server    | <----> |  iOS Simulator /  |
|   (Claude / LLM)  |  JSON  |  (daemon + CLI)    |  XCT   |  XCTest/XCUITest  |
+-------------------+        +--------------------+        +-------------------+
                                      |
                                      v
                            Perception Layer
                            (JSON snapshots, optional PNG screenshots)
```

### Components

- **Control Server / Daemon**: Runs on macOS, manages Simulator instances via `xcrun simctl` & Xcode test runners, exposes REST/Unix-socket/STDIO CLI
- **Perception**: Accessibility tree JSON + optional screenshot PNG (for vision model). Uses XCTest/XCUITest APIs to extract semantic tree
- **Fallback / Compatibility**: Supports WebDriverAgent / Appium layer for remote devices or alternative backends

---

## 3. Core Components & Responsibilities

### 3.1 CLI (`ios-agent`)

Commands:
- `open`, `install`, `launch`
- `snapshot --json`
- `screenshot`
- `tap <ref>`
- `type <ref> "text"`
- `swipe <ref> <direction>`
- `back`
- `reset-sim`
- `list-sims`

Outputs structured JSON to stdout for automation integration.

### 3.2 Daemon / Control API

- Manages simulator lifecycle (`simctl`)
- Builds & installs app
- Spawns XCTest runner, receives test logs
- Exposes HTTP/IPC for LLM connector and local CLI

### 3.3 XCTest Bridge (Swift test bundle)

Runs inside simulator process as an XCUITest target to:
- Query accessibility tree and serialize it
- Execute actions (tap/type/swipe) by element ref
- Produce stable element refs (opaque `@e123` tokens mapped to accessibility identifiers + query path)

Implemented using public XCTest/XCUITest APIs to remain App Store / Apple-safe.

### 3.4 Perception Serializer

- JSON schema (see section 5)
- Optionally attaches screenshot PNG via `xcrun simctl io booted screenshot`

### 3.5 Agent Connector

Small adapter that formats LLM prompts with the JSON snapshot plus available actions and sends chosen action back to CLI.

---

## 4. Implementation Constraints

- **Use only public APIs**: XCTest/XCUITest & simctl. Do not rely on private WebKit/CA/Metal internals
- **Accessibility completeness**: Some apps (WebViews, custom renderers) may expose limited elements. App teams should instrument views with `accessibilityIdentifier` and `accessibilityLabel`
- **Appium/WebDriverAgent**: Can be offered as compatibility backend for real devices or different protocols

---

## 5. Snapshot JSON Schema

```json
{
  "app": "com.example.App",
  "screen": "LoginView",
  "timestamp": "2026-01-16T10:12:00Z",
  "screenshot": "data:image/png;base64,...",
  "elements": [
    {
      "ref": "@e1",
      "type": "XCUIElementTypeButton",
      "label": "Log in",
      "identifier": "loginButton",
      "value": null,
      "frame": {"x": 12, "y": 780, "w": 351, "h": 48},
      "hittable": true,
      "children": ["@e3", "@e4"]
    }
  ],
  "actions_available": [
    {"name": "tap", "target": "@e1"},
    {"name": "type", "target": "@e5", "keyboard": "text"}
  ]
}
```

Notes:
- `ref`: Stable token created by XCTest Bridge for the current session. The daemon maps tokens to actual XCUIElement query paths
- `actions_available`: Enumerates atomic actions the runtime supports
- `screenshot`: Optional field for vision models

---

## 6. Element Referencing & Stability

Reference creation strategy:
- Combine `accessibilityIdentifier` (if present) + `elementType` + shallow index in parent
- Example: `ib:loginButton|button|0`
- Produce short opaque `@eNN` for the agent

Session map maintained in daemon re-resolves `@eNN` to current query on each action to handle view changes.

---

## 7. Action Model

Minimal atomic operations:

| Action | Description |
|--------|-------------|
| `tap(@e)` | Tap element center |
| `type(@e, "text")` | Focus & type (simulate keyboard) |
| `clear(@e)` | Clear text field |
| `swipe(@e, dir)` | Swipe on element or screen |
| `screenshot()` | Capture PNG |
| `snapshot()` | JSON accessibility dump |
| `launch(app, args)` | Launch app with arguments |
| `terminate(app)` | Terminate app |
| `wait_for(@e, timeout)` | Blocking wait for element visibility |

Actions map to XCTest calls (`.tap()`, `.typeText()`) in the test bundle.

---

## 8. CLI Contract

```bash
# Start simulator + install
ios-agent install ./app.app --sim "iPhone 14"
ios-agent launch com.example.App

# Get structured snapshot
ios-agent snapshot --json > snap.json

# Tap by ref
ios-agent tap --ref @e12

# Type into element
ios-agent type --ref @e9 --text "hello@example.com"

# Get screenshot
ios-agent screenshot --out out.png
```

CLI returns JSON envelope with:
- `status`: Success/error indicator
- `stdout`: Optional human-readable message
- `result`: Snapshot or action result data

---

## 9. Development Plan

### Phase 1: Proof of Concept

1. Create Xcode project with XCUITest target that:
   - Launches app in simulator
   - Recursively traverses root windows
   - Serializes `identifier`, `label`, `elementType`, `frame`, `hittable` to JSON
2. Implement macOS CLI wrapper that runs the test and collects JSON snapshot + screenshot

### Phase 2: Actions & Ref Mapping

3. Extend test bundle with `tap(@ref)` and `type(@ref, text)` functions
4. CLI invokes test runner with arguments

### Phase 3: Robustness & Session Management

5. Implement session mapping and stable refs
6. Add timeouts and retry logic (re-resolve refs if not hittable)
7. Define JSON action response schema

### Phase 4: LLM Integration

8. Build adapter that wraps snapshot into prompt template
9. Accept action responses from LLM and route to CLI

### Phase 5: Extended Backend Support

10. Add optional Appium/WDA backend for real devices
11. Use existing Appium XCUI driver for alternative element trees

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Incomplete accessibility** | Recommend dev instrumentation; provide SDK to auto-inject `accessibilityIdentifier` from view builder |
| **iOS/WDA quirks** | Maintain compatibility matrix and fallbacks for iOS versions / webviews |
| **Performance** | Use diffs & incremental snapshots for complex views |

---

## 11. Technical Viability

- **Proven pattern**: agent-browser demonstrates value of structured accessibility snapshots + atomic actions for LLM automation
- **Reliable tooling**: `simctl` enables scripting simulator lifecycle and screenshot capture
- **Existing infrastructure**: XCUITest uses accessibility tree for UI queries; snapshot-style tests already serialize to JSON
- **Alternative backends**: Appium/WDA implements XML/JSON page source APIs as reference implementation
