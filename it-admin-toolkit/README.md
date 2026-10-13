# itkit · IT Admin Toolkit

Small command-line tools for everyday IT administration: network discovery, asset inventory, user onboarding, SSH log analysis and certificate monitoring.

**Pure Python standard library.** No dependencies, so it runs on a fresh Windows or Linux machine where you can't install packages.

| Command | What it solves |
|---|---|
| `itkit scan` | Which devices are on this network, and what are they exposing? |
| `itkit inventory` | Hardware and OS snapshot of a machine, with warnings (full disk, no reboot in weeks, low RAM) |
| `itkit onboard` | Turns HR's new-hire CSV into usernames, secure initial passwords and a ready-to-review **Active Directory (PowerShell)** or **Linux** script |
| `itkit authlog` | Detects SSH brute-force attempts and flags logins that succeeded *after* repeated failures |
| `itkit certs` | Lists TLS certificates that expire soon. The exit code makes it usable in cron or monitoring |

## Install

```bash
git clone https://github.com/g131908/portfolio.git
cd portfolio/it-admin-toolkit
pip install -e .          # or run without installing: python -m itkit (with PYTHONPATH=src)
```

Requires Python 3.10+. Tested on Ubuntu and Windows in CI.

## Examples

### Onboarding new employees

```bash
itkit onboard examples/new_hires.csv --domain firma.de --target ad
```
```
USERNAME            EMAIL                        DEPARTMENT
------------------  ---------------------------  ----------
anna.mueller        anna.mueller@firma.de        Marketing
joerg.weiss         joerg.weiss@firma.de         IT
eleni.papadopoulou  eleni.papadopoulou@firma.de  Finance
anna.mueller2       anna.mueller2@firma.de       Sales
sean.obrien         sean.obrien@firma.de         IT

5 account(s) prepared. Review, then run:
  onboarding_out/accounts.csv
  onboarding_out/create_users.ps1
```

- German characters are transliterated correctly (`Müller → mueller`, `Weiß → weiss`). NFKD normalisation alone would give `muller`.
- Duplicate names get a numeric suffix. `--existing users.txt` avoids collisions with accounts that already exist.
- Passwords are generated with `secrets`, meet AD complexity rules and avoid look-alike characters (`I l 1 O 0`). Users must change them at first logon.
- Apostrophes are escaped for PowerShell (`O'Brien → 'O''Brien'`).
- Nothing is executed automatically. An admin reviews the generated script first.

### Spotting an SSH brute-force attack

```bash
itkit authlog /var/log/auth.log --firewall
```
```
Parsed 17 lines, 12 failed SSH logins.

SUSPICIOUS IP  FAILURES  USERNAMES TRIED
-------------  --------  -------------------------
203.0.113.45   6         admin, deploy, root, test
198.51.100.7   5         deploy, oracle, root

!! deploy logged in from 198.51.100.7 after repeated failures - investigate

# Suggested firewall rules:
sudo ufw deny from 203.0.113.45 to any port 22
sudo ufw deny from 198.51.100.7 to any port 22
```

### Network discovery

```bash
itkit scan 192.168.178.0/24                 # common ports: ssh, http(s), smb, rdp, printers ...
itkit scan 10.0.0.5 -p 1-1024 -f json       # JSON or CSV for further processing
```
Uses plain TCP connect, so no admin rights are needed. Scans run in parallel with a thread pool (a /24 with 11 ports takes a few seconds). Hosts with RDP, SMB, VNC or Telnet open are highlighted. Networks larger than 1024 hosts are refused on purpose.

> Only scan networks you own or are authorised to test.

### Inventory and certificates

```bash
itkit inventory -o asset-$(hostname).json --strict   # exit 1 if warnings found
itkit certs --file examples/hosts.txt --warn-days 21 # exit 0 ok / 1 warn / 2 error
```

## Design notes

- **Library first, CLI second.** Every command is a thin wrapper around a module (`itkit.scan`, `itkit.onboard`, …) that returns plain data. This keeps the logic testable and reusable in other scripts.
- **Machine-readable output.** All commands support `--format json` and the scanner also supports `--format csv`. Colours are turned off when output is piped or `NO_COLOR` is set.
- **Meaningful exit codes**, so the tools can be used in scheduled tasks and monitoring.
- **Tests:** 46 pytest cases, including a real socket listener for the scanner. CI runs them on Linux and Windows with Python 3.10 and 3.13.

```
src/itkit/
  cli.py        argument parsing and presentation
  scan.py       port scanner
  inventory.py  system information (Linux, Windows, macOS)
  onboard.py    usernames, passwords, AD/Linux script generation
  authlog.py    SSH log analysis
  certs.py      TLS expiry checks
  output.py     tables, JSON, CSV
tests/          pytest suite
examples/       sample HR CSV, auth.log, host list
```

## License

MIT
