# Antigravity Quota Monitor

A VSCode/Antigravity extension that displays your model quota usage in the status bar.

## Features

- **Status bar quota display** — shows the remaining quota percentage for your selected model at a glance
- **Model picker** — click the status bar item or run `Antigravity Quota: Select Model` to switch between models
- **Color-coded indicators** — green (>50%), yellow (>20%), red (≤20%) so you know when you're running low
- **Auto-refresh** — quota data refreshes automatically every 2 minutes (configurable)
- **Manual refresh** — run `Antigravity Quota: Refresh` from the command palette any time

## How it works

The extension discovers the local Antigravity `language_server` process, extracts its CSRF token and API port from the process command line, and calls the `GetUserStatus` endpoint over HTTPS to fetch quota data for all available models.

## Installation

### From VSIX

1. Install the packaging tool:
   ```
   npm install -g @vscode/vsce
   ```
2. Clone and build:
   ```
   git clone https://github.com/SethBling/AntigravityQuotaMonitor.git
   cd AntigravityQuotaMonitor
   npm install
   vsce package
   ```
3. Install the `.vsix`:
   - Open Antigravity → Command Palette → **Extensions: Install from VSIX...**
   - Select the generated `antigravity-quota-monitor-0.1.0.vsix` file

### For development

1. Open this folder in VSCode/Antigravity
2. Run `npm install`
3. Press `F5` to launch the Extension Development Host

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravityQuota.refreshIntervalSeconds` | `120` | How often (in seconds) to auto-refresh quota data |

## Requirements

- **Windows** — process discovery uses PowerShell
- **Antigravity** must be running locally

## License

MIT
