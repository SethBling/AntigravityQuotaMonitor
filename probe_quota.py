"""
Antigravity Quota Probe - Single-run script to fetch and display model quota usage.

Workflow:
  1. Find the Antigravity language_server process via PowerShell
  2. Extract the CSRF token and extension port from its command-line args
  3. Find which ports the process is listening on
  4. Probe each port to find the working API endpoint
  5. Call GetUserStatus to fetch quota data
  6. Display the results

Requirements: Python 3.8+, Windows with Antigravity running locally.
No external dependencies — uses only the standard library.
"""

import subprocess
import json
import ssl
import re
import sys
import logging
import urllib.request
from typing import Optional

# ---------------------------------------------------------------------------
# Logging setup — set to DEBUG to see every step, INFO for summary only
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("quota_probe")


# ---------------------------------------------------------------------------
# Step 1: Find the language_server process and extract credentials
# ---------------------------------------------------------------------------
def find_antigravity_process() -> Optional[dict]:
    """
    Use PowerShell to list processes whose name contains 'language_server'.
    Parse the command-line arguments to extract:
      - PID
      - --extension_server_port  (HTTP port)
      - CSRF token (from --csrf_token or embedded in args)
    Returns dict with keys: pid, extension_port, csrf_token  — or None.
    """
    log.info("Searching for Antigravity language_server process...")

    # PowerShell command to get process ID and full command line
    ps_cmd = (
        "Get-CimInstance Win32_Process "
        "| Where-Object { $_.Name -like '*language_server*' } "
        "| Select-Object ProcessId, CommandLine "
        "| ConvertTo-Json"
    )

    log.debug("Running PowerShell command: %s", ps_cmd)

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        log.error("PowerShell command timed out after 15 seconds")
        return None

    if result.returncode != 0:
        log.error("PowerShell failed (exit code %d): %s", result.returncode, result.stderr.strip())
        return None

    stdout = result.stdout.strip()
    if not stdout:
        log.error("No language_server process found. Is Antigravity running?")
        return None

    log.debug("Raw PowerShell output (first 500 chars): %s", stdout[:500])

    # Parse JSON — PowerShell returns a single object or an array
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        log.error("Failed to parse PowerShell JSON output: %s", e)
        return None

    # Normalize to list
    processes = data if isinstance(data, list) else [data]
    log.info("Found %d language_server process(es)", len(processes))

    for proc in processes:
        pid = proc.get("ProcessId")
        cmdline = proc.get("CommandLine", "")
        log.debug("PID %s command line (first 300 chars): %s", pid, cmdline[:300])

        # Extract --extension_server_port
        port_match = re.search(r"--extension_server_port[=\s]+(\d+)", cmdline)
        extension_port = int(port_match.group(1)) if port_match else None

        # Extract CSRF token — look for a long hex/base64 token after known flag names
        csrf_match = re.search(r"--csrf[_-]token[=\s]+(\S+)", cmdline, re.IGNORECASE)
        csrf_token = csrf_match.group(1) if csrf_match else None

        if csrf_token:
            log.info(
                "Process PID=%s: extension_port=%s, csrf_token=%s...%s",
                pid,
                extension_port,
                csrf_token[:6],
                csrf_token[-4:] if len(csrf_token) > 10 else "****",
            )
            return {
                "pid": pid,
                "extension_port": extension_port,
                "csrf_token": csrf_token,
            }
        else:
            log.debug("PID %s: no CSRF token found in command line, skipping", pid)

    log.error("Found language_server process(es) but could not extract CSRF token")
    return None


# ---------------------------------------------------------------------------
# Step 2: Find the ports this process is listening on
# ---------------------------------------------------------------------------
def get_listening_ports(pid: int) -> list[int]:
    """
    Use PowerShell Get-NetTCPConnection to find all TCP ports that the
    given PID is listening on.
    """
    log.info("Finding listening ports for PID %d...", pid)

    ps_cmd = (
        f"Get-NetTCPConnection -OwningProcess {pid} -State Listen -ErrorAction SilentlyContinue "
        "| Select-Object -ExpandProperty LocalPort "
        "| Sort-Object -Unique"
    )

    log.debug("Running: %s", ps_cmd)

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        log.error("Port listing timed out")
        return []

    ports = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if line.isdigit():
            ports.append(int(line))

    log.info("Listening ports: %s", ports)
    return ports


# ---------------------------------------------------------------------------
# Step 3: Probe ports to find the working API endpoint
# ---------------------------------------------------------------------------
def probe_port(port: int, csrf_token: str) -> bool:
    """
    Send a lightweight GetUnleashData request to the given port over HTTPS.
    Returns True if the port responds with HTTP 200.
    """
    log.debug("Probing port %d...", port)

    body = json.dumps({
        "context": {
            "properties": {
                "devMode": "false",
                "ide": "antigravity",
                "language": "UNSPECIFIED",
            }
        }
    }).encode()

    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUnleashData"

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Connect-Protocol-Version", "1")
    req.add_header("X-Codeium-Csrf-Token", csrf_token)

    # Allow self-signed certs on localhost
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=3, context=ctx) as resp:
            log.debug("Port %d responded with HTTP %d", port, resp.status)
            return resp.status == 200
    except Exception as e:
        log.debug("Port %d probe failed: %s", port, e)
        return False


def find_working_port(ports: list[int], csrf_token: str) -> Optional[int]:
    """Try each candidate port and return the first one that responds."""
    for port in ports:
        if probe_port(port, csrf_token):
            log.info("Working API port found: %d", port)
            return port
    return None


# ---------------------------------------------------------------------------
# Step 4: Fetch quota data via GetUserStatus
# ---------------------------------------------------------------------------
def fetch_quota(port: int, csrf_token: str) -> Optional[dict]:
    """
    Call the GetUserStatus endpoint and return the raw JSON response.
    """
    log.info("Fetching quota from port %d...", port)

    body = json.dumps({
        "metadata": {
            "ideName": "antigravity",
            "extensionName": "antigravity",
            "locale": "en",
        }
    }).encode()

    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus"

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Connect-Protocol-Version", "1")
    req.add_header("X-Codeium-Csrf-Token", csrf_token)

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            raw = resp.read().decode()
            log.debug("GetUserStatus response length: %d bytes", len(raw))
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        log.error("HTTP %d from GetUserStatus: %s", e.code, body_text[:300])
        return None
    except Exception as e:
        log.error("GetUserStatus request failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Step 5: Parse and display the quota information
# ---------------------------------------------------------------------------
def display_quota(data: dict) -> None:
    """
    Parse the GetUserStatus response and print a readable summary.

    Known response structure (discovered from live API):
      data["userStatus"]["cascadeModelConfigData"]["clientModelConfigs"] -> list of models
      Each model has:
        - "label": display name (e.g. "Claude Sonnet 4.5")
        - "modelOrAlias.model": internal model ID
        - "quotaInfo.remainingFraction": float 0.0-1.0
        - "quotaInfo.resetTime": ISO 8601 timestamp
    """
    # Pretty-print the entire raw response at DEBUG level for inspection
    log.debug("Full response:\n%s", json.dumps(data, indent=2, default=str)[:5000])

    print("\n" + "=" * 60)
    print("  ANTIGRAVITY MODEL QUOTA REPORT")
    print("=" * 60)

    user_status = data.get("userStatus", {})

    # User info
    name = user_status.get("name", "Unknown")
    email = user_status.get("email", "")
    print(f"\n  User: {name} ({email})")

    # Plan info
    plan_status = user_status.get("planStatus", {})
    plan_info = plan_status.get("planInfo", {})
    plan_name = plan_info.get("planName", "Unknown")
    prompt_credits = plan_status.get("availablePromptCredits", "?")
    flow_credits = plan_status.get("availableFlowCredits", "?")
    print(f"  Plan: {plan_name}")
    print(f"  Prompt Credits: {prompt_credits}  |  Flow Credits: {flow_credits}")

    # Model quotas
    model_config = user_status.get("cascadeModelConfigData", {})
    models = model_config.get("clientModelConfigs", [])

    if not models:
        print("\n  No model quota data found in response.")
        log.warning("clientModelConfigs was empty or missing")
        log.debug("userStatus keys: %s", list(user_status.keys()))
    else:
        print(f"\n  {'Model':<35} {'Quota':>7}  {'Resets At'}")
        print("  " + "-" * 60)

        for model in models:
            label = model.get("label", "Unknown")
            quota_info = model.get("quotaInfo", {})
            fraction = quota_info.get("remainingFraction")
            reset_time = quota_info.get("resetTime", "")

            if fraction is not None:
                pct = int(fraction * 100)
                # Color indicator
                if pct > 50:
                    icon = "🟢"
                elif pct > 20:
                    icon = "🟡"
                else:
                    icon = "🔴"
                quota_str = f"{icon} {pct:>3}%"
            else:
                quota_str = "   N/A"

            # Format reset time (show just HH:MM if today, otherwise date+time)
            reset_display = reset_time[:16].replace("T", " ") if reset_time else ""

            print(f"  {label:<35} {quota_str}  {reset_display}")

    print("\n" + "=" * 60 + "\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    print("Antigravity Quota Probe")
    print("-" * 40)

    # Step 1: Find the process
    proc_info = find_antigravity_process()
    if not proc_info:
        log.error("FAILED: Could not find Antigravity language_server process.")
        log.error("Make sure Antigravity IDE is running.")
        return 1

    pid = proc_info["pid"]
    csrf_token = proc_info["csrf_token"]

    # Step 2: Find listening ports
    ports = get_listening_ports(pid)
    if not ports:
        log.error("FAILED: Process PID=%d is not listening on any ports.", pid)
        return 1

    # Step 3: Probe to find the working API port
    api_port = find_working_port(ports, csrf_token)
    if not api_port:
        # Fallback: try the extension_port directly if probe failed
        ext_port = proc_info.get("extension_port")
        if ext_port:
            log.info("Probing failed on all ports. Trying extension_port %d as fallback...", ext_port)
            api_port = ext_port
        else:
            log.error("FAILED: Could not find a working API port.")
            return 1

    # Step 4: Fetch quota
    quota_data = fetch_quota(api_port, csrf_token)
    if not quota_data:
        log.error("FAILED: Could not fetch quota data.")
        return 1

    # Step 5: Display
    display_quota(quota_data)

    return 0


if __name__ == "__main__":
    sys.exit(main())
