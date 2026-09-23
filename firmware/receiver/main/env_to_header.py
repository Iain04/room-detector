"""Turn the repo-root .env file into a C header of #defines.

Run automatically by main/CMakeLists.txt at configure time. Only the keys in
ALLOWED are exported; empty values are skipped so menuconfig values apply.
"""
import sys
from pathlib import Path

ALLOWED = [
    "WIFI_SSID", "WIFI_PASSWORD",
    "MQTT_BROKER_URL", "MQTT_TELEMETRY_TOPIC", "MQTT_USERNAME", "MQTT_PASSWORD",
    "ROOM_ID", "DEVICE_ID", "CSI_SOURCE", "SENDER_MAC", "SNTP_SERVER",
]


def parse_env(path: Path) -> dict[str, str]:
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main() -> None:
    env_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    values = parse_env(env_path)
    lines = ["/* Generated from .env by env_to_header.py - do not edit. */", "#pragma once", ""]
    for key in ALLOWED:
        if values.get(key):
            lines.append(f"#define ENV_{key} {c_string(values[key])}")
    content = "\n".join(lines) + "\n"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Only rewrite when changed, so unchanged .env doesn't force a recompile.
    if not out_path.exists() or out_path.read_text(encoding="utf-8") != content:
        out_path.write_text(content, encoding="utf-8")
    used = [k for k in ALLOWED if values.get(k)]
    print(f"-- .env: {env_path} ({'found' if env_path.exists() else 'not found'}), "
          f"overriding: {', '.join(used) if used else 'nothing'}")


if __name__ == "__main__":
    main()
