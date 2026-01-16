Nice — below is a concise, implementation-grade specification you can hand to engineers to build an agent-browser for iOS (an “ios-agent”) that gives Claude (or any LLM) structured eyes + programmatic hands over iOS apps running in the Simulator. I researched existing tooling and constraints and folded them into the design (sources cited for the load-bearing claims).

iOS-Agent — concise spec

1) Goal (one line)

Provide a CLI + daemon that exposes a stable, JSON-first automation API for iOS apps (Simulator) so an LLM receives accessibility snapshots and can perform atomic UI actions (tap, type, swipe, screenshot, snapshot-json) without human interpretation.

(Web pattern: agent-browser — do the same for iOS.)  ￼

⸻

2) High-level architecture

+-------------------+        +--------------------+       +------------------+
|   LLM Agent       | <----> |  Control Server    | <----> | iOS Simulator /  |
| (Claude / LLM)    |  JSON  |  (daemon + CLI)    |  XCT   | XCTest/XCUITest   |
+-------------------+        +--------------------+       +------------------+
                                     |
                                     v
                           Perception Layer (JSON snapshots,
                           optionally PNG screenshots)

	•	Control Server / Daemon: runs on macOS, manages Simulator instances via xcrun simctl & Xcode test runners, exposes REST/Unix-socket/STDIO CLI.  ￼
	•	Perception: accessibility tree JSON + optional screenshot PNG (for vision model). Use XCTest/XCUITest APIs to extract semantic tree.  ￼
	•	Fallback / Compatibility: support WebDriverAgent / Appium layer if user prefers remote device or alternative backend. (Appium/WDA already serializes an element tree.)  ￼

⸻

3) Core components & responsibilities
	1.	CLI (ios-agent)
	•	Commands: open, install, launch, snapshot --json, screenshot, tap <ref>, type <ref> "text", swipe <ref> direction, back, reset-sim, list-sims.
	•	Outputs structured JSON to stdout for automation integration.
	2.	Daemon / Control API
	•	Manages simulator lifecycle (simctl), builds & installs app, spawns XCTest runner, receives test logs.
	•	Exposes HTTP/IPC for LLM connector and local CLI.
	3.	XCTest Bridge (Swift test bundle)
	•	Runs inside simulator process as an XCUITest target to:
	•	Query accessibility tree and serialize it.
	•	Execute actions (tap/type/swipe) by element ref.
	•	Produce stable element refs (opaque @e123 tokens mapped to accessibility identifiers + query path).
	•	Implemented using public XCTest/XCUITest APIs to remain App Store / Apple-safe.  ￼
	4.	Perception Serializer
	•	JSON schema (see section 5).
	•	Optionally attach screenshot PNG (via xcrun simctl io booted screenshot) for vision models.  ￼
	5.	Agent connector
	•	Small adapter that formats LLM prompts with the JSON snapshot plus available actions (like agent-browser skills do) and sends chosen action back to CLI. Use Claude Code / custom skill pattern.  ￼

⸻

4) Implementation notes / constraints (important)
	•	Use only public XCTest/XCUITest & simctl APIs. Do not rely on private WebKit/CA/Metal internals — Apple forbids that.  ￼
	•	Some apps (WebViews, custom renderers) may expose a single rendered element; accessibility completeness depends on app authors setting identifiers/labels. App teams should instrument views with accessibilityIdentifier and accessibilityLabel. Appium/Inspector experience shows this is the main practical limit.  ￼
	•	Appium/WebDriverAgent can be offered as a compatibility backend to run tests on real devices or different protocols (but WDA has its own quirks).  ￼

⸻

5) Snapshot JSON schema (recommended)

A compact machine-friendly schema LLMs can reason about.

{
  "app": "com.example.App",
  "screen": "LoginView",
  "timestamp": "2026-01-16T10:12:00+05:30",
  "screenshot": "data:image/png;base64,...",    // optional
  "elements": [
    {
      "ref": "@e1",
      "type": "XCUIElementTypeButton",
      "label": "Log in",
      "identifier": "loginButton",
      "value": null,
      "frame": {"x": 12, "y": 780, "w": 351, "h": 48},
      "hittable": true,
      "children": ["@e3","@e4"]
    },
    ...
  ],
  "actions_available": [
    {"name": "tap", "target": "@e1"},
    {"name": "type", "target": "@e5", "keyboard": "text"}
  ]
}

	•	ref is a stable token created by the XCTest Bridge for the current session. The daemon maps tokens to the actual XCUIElement query path.
	•	actions_available enumerates atomic actions the runtime supports (so the LLM can choose without guessing).

(Technique: many iOS UI testing libs serialize the accessibility tree; see snapshot test approaches.)  ￼

⸻

6) Element referencing & stability
	•	Create refs using: accessibilityIdentifier (if present) + elementType + shallow index in parent. E.g. ib:loginButton|button|0. Then produce a short opaque @eNN for the agent.
	•	Maintain a session map in the daemon that re-resolves @eNN to current query each action to handle small view changes.

⸻

7) Action model (atomic operations)

Minimal set to start:
	•	tap(@e) — tap element center
	•	type(@e, "text") — focus & type (simulate keyboard)
	•	clear(@e) — clear text field
	•	swipe(@e, dir) — swipe on element or screen
	•	screenshot() — PNG
	•	snapshot() — JSON accessibility dump
	•	launch(app, args) / terminate(app)
	•	wait_for(@e, timeout) — blocking wait for element visibility

Map these to XCTest calls (e.g. .tap(), .typeText()) in the test bundle.

⸻

8) CLI contract (examples)

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

CLI returns JSON envelope with status, stdout (human message optional), and result (the snapshot or action result).

⸻

9) MVP development plan (concrete steps)

Week 0 — PoC (1 dev, mac)
	1.	Create a small Xcode project with an XCUITest target that: launches app in simulator, traverses root windows and recursively serializes identifier, label, elementType, frame, hittable into JSON and writes to stdout/file. (Prove perception loop.)  ￼
	2.	Implement a small macOS CLI wrapper that runs the test and collects the JSON snapshot and screenshot (xcrun simctl io booted screenshot).  ￼

Week 1 — Actions & ref mapping
3. Extend test bundle to expose functions to perform tap(@ref) and type(@ref, text). Have CLI invoke test runner with arguments.

Week 2 — Robustness & session
4. Implement session mapping, stable refs, timeouts, and basic retry logic (re-resolve refs if not hittable).
5. Add JSON action response schema.

Week 3 — LLM integration
6. Build a tiny adapter that wraps snapshot into a prompt template (like agent-browser skill) and accepts an action back from LLM.  ￼

Week 4 — Edge cases + Appium/WDA backend
7. Add optional Appium/WDA backend to support real devices or alternative element trees. (Use existing Appium XCUI driver.)  ￼

⸻

10) Risks & mitigations
	•	Incomplete accessibility: If the app owner hasn’t set identifiers, tree may be unusable. Mitigation: recommend dev instrumentation and provide a small SDK to auto-inject accessibilityIdentifier from view builder.  ￼
	•	iOS/WDA quirks: Appium/WDA sometimes fails for certain iOS versions / webviews; keep compatibility matrix and fallbacks.  ￼
	•	Performance: Page-source / tree dumps can be slow for complex views. Use diffs & incremental snapshots (snapshot tests approach).  ￼

⸻

11) Why this is viable (evidence)
	•	agent-browser shows the value of structured accessibility snapshots + atomic actions for LLM automation. The same pattern — snapshots + small action set — maps to iOS via XCTest/XCUITest.  ￼
	•	simctl lets you script simulator lifecycle and capture screenshots from CLI reliably.  ￼
	•	XCUITest uses the app’s accessibility tree for UI queries; teams already use snapshot-style tests that serialize the accessibility tree to JSON.  ￼
	•	Appium/WDA already implements XML/JSON page source APIs and locator strategies for iOS; it can be used as an alternate backend or reference implementation.  ￼

⸻

12) Deliverables I can produce for you right now (pick any)
	•	Full JSON schema + example snapshots from a sample app.
	•	Swift XCUITest code (complete) that serializes accessibility tree and performs actions.
	•	Node/Rust CLI skeleton that calls Xcode test runner and simctl.
	•	LLM prompt templates and an example Claude skill to drive the flow.

Tell me which deliverable you want first and which language for the CLI (Node/Rust/Python). I’ll generate code and concrete files.
