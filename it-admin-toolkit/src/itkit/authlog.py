"""Find SSH brute-force attempts in a Linux auth log (/var/log/auth.log or journalctl output)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

FAILED = re.compile(
    r"Failed password for (?:invalid user )?(?P<user>\S+) from (?P<ip>[\d.:a-fA-F]+) port \d+")
INVALID = re.compile(r"Invalid user (?P<user>\S+) from (?P<ip>[\d.:a-fA-F]+)")
ACCEPTED = re.compile(
    r"Accepted (?P<method>password|publickey) for (?P<user>\S+) from (?P<ip>[\d.:a-fA-F]+)")


@dataclass
class Report:
    failed_by_ip: Counter = field(default_factory=Counter)
    users_by_ip: dict = field(default_factory=lambda: defaultdict(set))
    invalid_users: Counter = field(default_factory=Counter)
    accepted: list = field(default_factory=list)
    lines: int = 0

    def suspicious(self, threshold: int = 5) -> list[tuple[str, int]]:
        return [(ip, n) for ip, n in self.failed_by_ip.most_common() if n >= threshold]

    def compromised_candidates(self, threshold: int = 5) -> list[dict]:
        """Successful logins from an IP that also had many failures: check these first."""
        bad = {ip for ip, _ in self.suspicious(threshold)}
        return [a for a in self.accepted if a["ip"] in bad]

    def to_dict(self, threshold: int = 5) -> dict:
        return {
            "lines_parsed": self.lines,
            "failed_logins": sum(self.failed_by_ip.values()),
            "suspicious_ips": [
                {"ip": ip, "failures": n, "usernames_tried": sorted(self.users_by_ip[ip])[:10]}
                for ip, n in self.suspicious(threshold)
            ],
            "top_invalid_usernames": self.invalid_users.most_common(10),
            "successful_logins": self.accepted,
            "successful_after_bruteforce": self.compromised_candidates(threshold),
        }


def parse(lines: Iterable[str]) -> Report:
    r = Report()
    for line in lines:
        r.lines += 1
        if m := FAILED.search(line):
            r.failed_by_ip[m["ip"]] += 1
            r.users_by_ip[m["ip"]].add(m["user"])
        elif m := INVALID.search(line):
            r.invalid_users[m["user"]] += 1
        elif m := ACCEPTED.search(line):
            r.accepted.append({"user": m["user"], "ip": m["ip"], "method": m["method"]})
    return r


def firewall_commands(ips: list[str]) -> str:
    """Firewall commands an admin can paste after reviewing the report."""
    return "\n".join(f"sudo ufw deny from {ip} to any port 22" for ip in ips)
