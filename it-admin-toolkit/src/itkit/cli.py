"""Command-line interface: `itkit <command> [options]`."""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from itkit import __version__, authlog, certs, inventory, onboard, scan
from itkit.output import color, table, to_csv, to_json


def cmd_scan(a: argparse.Namespace) -> int:
    ports = scan.parse_ports(a.ports)
    t0 = time.perf_counter()
    hosts = scan.scan(a.target, ports, timeout=a.timeout, resolve=not a.no_dns)
    elapsed = time.perf_counter() - t0
    data = [h.to_dict() for h in hosts]
    if a.format == "json":
        print(to_json(data))
    elif a.format == "csv":
        print(to_csv(data), end="")
    else:
        rows = [[h.ip, h.hostname, ", ".join(h.services)] for h in hosts]
        print(table(rows, ["IP", "HOSTNAME", "OPEN SERVICES"]))
        print(f"\n{len(hosts)} host(s) with open ports, {len(ports)} port(s) checked in {elapsed:.1f}s")
        risky = [h for h in hosts if {23, 445, 3389, 5900} & set(h.open_ports)]
        for h in risky:
            print(color(f"! {h.ip}: remote-access/file-sharing port exposed ({', '.join(h.services)})", "WARN"))
    return 0


def cmd_inventory(a: argparse.Namespace) -> int:
    info = inventory.collect()
    problems = inventory.warnings(info, a.disk_threshold)
    if a.format == "json":
        print(to_json({**info, "warnings": problems}))
    else:
        flat = [[k, v] for k, v in info.items() if k != "disks"]
        print(table(flat, ["FIELD", "VALUE"]))
        print()
        disk_rows = [[d["mount"], d["total_gb"], d["free_gb"], f"{d['used_pct']}%"] for d in info["disks"]]
        print(table(disk_rows, ["MOUNT", "TOTAL GB", "FREE GB", "USED"]))
        for p in problems:
            print(color(f"! {p}", "WARN"))
    if a.output:
        Path(a.output).write_text(to_json({**info, "warnings": problems}), encoding="utf-8")
        print(f"\nSaved to {a.output}", file=sys.stderr)
    return 1 if problems and a.strict else 0


def cmd_onboard(a: argparse.Namespace) -> int:
    rows = onboard.read_hires(Path(a.csv))
    existing = set()
    if a.existing:
        existing = {line.strip().lower() for line in Path(a.existing).read_text().splitlines() if line.strip()}
    accounts = onboard.build_accounts(rows, a.domain, existing)
    files = onboard.write_outputs(accounts, Path(a.out), a.target, a.ou)
    rows = [[x.username, x.email, x.department] for x in accounts]
    print(table(rows, ["USERNAME", "EMAIL", "DEPARTMENT"]))
    print(f"\n{len(accounts)} account(s) prepared. Review, then run:")
    for f in files:
        print(f"  {f}")
    print(color("accounts.csv contains initial passwords - hand over securely and delete afterwards.", "WARN"))
    return 0


def cmd_authlog(a: argparse.Namespace) -> int:
    with open(a.logfile, encoding="utf-8", errors="replace") as f:
        report = authlog.parse(f)
    data = report.to_dict(a.threshold)
    if a.format == "json":
        print(to_json(data))
        return 0
    print(f"Parsed {data['lines_parsed']} lines, {data['failed_logins']} failed SSH logins.\n")
    rows = [[s["ip"], s["failures"], ", ".join(s["usernames_tried"][:4])] for s in data["suspicious_ips"]]
    print(table(rows, ["SUSPICIOUS IP", "FAILURES", "USERNAMES TRIED"]))
    if data["successful_after_bruteforce"]:
        print()
        for s in data["successful_after_bruteforce"]:
            print(color(f"!! {s['user']} logged in from {s['ip']} after repeated failures - investigate", "HIGH"))
    if a.firewall and data["suspicious_ips"]:
        print("\n# Suggested firewall rules:")
        print(authlog.firewall_commands([s["ip"] for s in data["suspicious_ips"]]))
    return 0


def cmd_certs(a: argparse.Namespace) -> int:
    targets = list(a.hosts)
    if a.file:
        targets += [l.strip() for l in Path(a.file).read_text().splitlines() if l.strip() and not l.startswith("#")]
    if not targets:
        print("no hosts given", file=sys.stderr)
        return 2
    results = certs.check_many(targets, a.timeout)
    worst = 0
    rows = []
    for r in sorted(results, key=lambda r: (r.days_left is None, r.days_left or 0)):
        lvl = r.level(a.warn_days)
        worst = max(worst, {"OK": 0, "WARN": 1}.get(lvl, 2))
        rows.append([f"{r.host}:{r.port}", lvl, r.days_left, r.issuer or r.error])
    if a.format == "json":
        print(to_json([{**r.__dict__, "level": r.level(a.warn_days)} for r in results]))
    else:
        print(table(rows, ["HOST", "STATUS", "DAYS LEFT", "ISSUER / ERROR"]))
    return worst  # 0 ok, 1 warn, 2 error - handy for cron/monitoring


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="itkit", description="Everyday IT admin tools.")
    p.add_argument("--version", action="version", version=f"itkit {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="find hosts and open ports in a network")
    s.add_argument("target", help="IP, CIDR range (192.168.1.0/24) or hostname")
    s.add_argument("-p", "--ports", help="e.g. 22,80,443 or 8000-8100 (default: common ports)")
    s.add_argument("-t", "--timeout", type=float, default=0.5)
    s.add_argument("--no-dns", action="store_true", help="skip reverse DNS lookups")
    s.add_argument("-f", "--format", choices=["table", "json", "csv"], default="table")
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser("inventory", help="hardware/software snapshot of this machine")
    s.add_argument("-f", "--format", choices=["table", "json"], default="table")
    s.add_argument("-o", "--output", help="also save JSON to this file")
    s.add_argument("--disk-threshold", type=float, default=90.0)
    s.add_argument("--strict", action="store_true", help="exit 1 if warnings were found")
    s.set_defaults(func=cmd_inventory)

    s = sub.add_parser("onboard", help="generate user accounts from an HR CSV")
    s.add_argument("csv", help="columns: first_name,last_name,department[,title,start_date]")
    s.add_argument("-d", "--domain", required=True, help="e-mail domain, e.g. example.com")
    s.add_argument("--target", choices=["ad", "linux"], default="ad")
    s.add_argument("--ou", default="OU=Users,DC=example,DC=com", help="AD organizational unit")
    s.add_argument("--existing", help="file with usernames that already exist (one per line)")
    s.add_argument("-o", "--out", default="onboarding_out")
    s.set_defaults(func=cmd_onboard)

    s = sub.add_parser("authlog", help="detect SSH brute-force attempts in auth.log")
    s.add_argument("logfile")
    s.add_argument("--threshold", type=int, default=5, help="failures before an IP counts as suspicious")
    s.add_argument("--firewall", action="store_true", help="print ufw rules for suspicious IPs")
    s.add_argument("-f", "--format", choices=["table", "json"], default="table")
    s.set_defaults(func=cmd_authlog)

    s = sub.add_parser("certs", help="check TLS certificate expiry")
    s.add_argument("hosts", nargs="*", help="host or host:port")
    s.add_argument("--file", help="file with one host per line")
    s.add_argument("--warn-days", type=int, default=30)
    s.add_argument("-t", "--timeout", type=float, default=5.0)
    s.add_argument("-f", "--format", choices=["table", "json"], default="table")
    s.set_defaults(func=cmd_certs)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
