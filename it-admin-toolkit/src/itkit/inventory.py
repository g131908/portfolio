"""Collect a hardware/software snapshot of the current machine.

Standard library only, so it runs on a fresh Windows or Linux install.
Useful for asset lists before a rollout or when opening a support ticket.
"""
from __future__ import annotations

import getpass
import os
import platform
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone

GB = 1024 ** 3


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def memory_gb() -> float | None:
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return round(int(line.split()[1]) * 1024 / GB, 1)
        except OSError:
            return None
    if sys.platform == "win32":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        return round(stat.ullTotalPhys / GB, 1)
    if sys.platform == "darwin":
        out = _run(["sysctl", "-n", "hw.memsize"])
        return round(int(out) / GB, 1) if out.isdigit() else None
    return None


def uptime_hours() -> float | None:
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/uptime") as f:
                return round(float(f.read().split()[0]) / 3600, 1)
        except OSError:
            return None
    if sys.platform == "win32":
        import ctypes
        return round(ctypes.windll.kernel32.GetTickCount64() / 3_600_000, 1)
    return None


def cpu_model() -> str:
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except OSError:
            pass
    return platform.processor() or platform.machine()


def disks() -> list[dict]:
    if sys.platform == "win32":
        roots = [f"{d}:\\" for d in "CDEFGHIJ" if os.path.exists(f"{d}:\\")]
    else:
        roots = ["/"] + [p for p in ("/home", "/var") if os.path.ismount(p)]
    out = []
    for root in roots:
        try:
            u = shutil.disk_usage(root)
        except OSError:
            continue
        out.append({
            "mount": root,
            "total_gb": round(u.total / GB, 1),
            "free_gb": round(u.free / GB, 1),
            "used_pct": round(u.used / u.total * 100, 1) if u.total else 0.0,
        })
    return out


def local_ip() -> str | None:
    # A UDP "connect" picks the outgoing interface without sending a packet.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def collect() -> dict:
    return {
        "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "os": f"{platform.system()} {platform.release()}",
        "os_version": platform.version(),
        "architecture": platform.machine(),
        "cpu": cpu_model(),
        "cpu_cores": os.cpu_count(),
        "memory_gb": memory_gb(),
        "uptime_h": uptime_hours(),
        "ip": local_ip(),
        "python": platform.python_version(),
        "disks": disks(),
    }


def warnings(info: dict, disk_threshold: float = 90.0) -> list[str]:
    """Return human-readable problems worth a support ticket."""
    out = []
    for d in info.get("disks", []):
        if d["used_pct"] >= disk_threshold:
            out.append(f"Disk {d['mount']} is {d['used_pct']}% full ({d['free_gb']} GB free)")
    if (info.get("uptime_h") or 0) > 24 * 30:
        out.append(f"No reboot for {info['uptime_h'] / 24:.0f} days - pending updates likely")
    if info.get("memory_gb") is not None and info["memory_gb"] < 8:
        out.append(f"Only {info['memory_gb']} GB RAM - below 8 GB office baseline")
    return out
