# Installing the fork

This is [`arynyklas/oh-my-pi`](https://github.com/arynyklas/oh-my-pi), a fork of
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). It tracks upstream releases and adds work
that is not in upstream — most of it around the auth broker and the multi-account
[auth gateway](auth-broker-gateway.md).

The important consequence for installing: **the fork ships binaries only.** Nothing is published to
npm. Every upstream install path that goes through a package manager — `bun install -g
@oh-my-pi/pi-coding-agent`, `npm i -g`, Homebrew, `curl https://omp.sh/install | sh` — gives you
**upstream's** build, not this one. Use the instructions below instead.

| | |
|---|---|
| Version scheme | `X.Y.Z-fork.N` (upstream `X.Y.Z` plus a fork counter) |
| Release tags | `vX.Y.Z-fork.N`, always non-draft and non-prerelease |
| Published assets | `omp-windows-x64.exe`, `omp-linux-x64`, `SHA256SUMS` |
| Not published | macOS, ARM, musl, npm packages |
| Release branch | `release/fork` (also the repo default branch) |

macOS, Linux ARM, and musl are not built. On those, [build from source](#build-from-source).

## Windows

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/arynyklas/oh-my-pi/release/fork/scripts/install-fork.ps1 | iex
```

That resolves the newest `vX.Y.Z-fork.N` release, downloads `omp-windows-x64.exe`, **verifies its
SHA-256 against the release `SHA256SUMS`**, installs it as `omp.exe` in `%LOCALAPPDATA%\omp`, adds
that directory to your user `PATH`, and points omp at Git Bash if it finds one.

> Do not use upstream's `scripts/install.ps1` here. Without `-Binary` it installs from npm, which is
> upstream's build; with `-Binary` it pulls from the `can1357` repo. Either way you do not get the
> fork.

### Options

The one-liner takes no arguments, so pass options through a script block:

```powershell
$s = irm https://raw.githubusercontent.com/arynyklas/oh-my-pi/release/fork/scripts/install-fork.ps1

& ([scriptblock]::Create($s)) -Version v17.2.15-fork.1   # pin an exact release
& ([scriptblock]::Create($s)) -InstallDir C:\tools\omp   # install somewhere else
& ([scriptblock]::Create($s)) -NoPath                    # do not touch user PATH
```

| Flag | Effect |
|---|---|
| `-Version <tag>` | Install exactly this tag. `v` prefix optional. Non-`-fork.N` tags are rejected. |
| `-InstallDir <path>` | Target directory. Defaults to `$env:PI_INSTALL_DIR`, else `%LOCALAPPDATA%\omp`. |
| `-NoPath` | Skip the user `PATH` update. |

Set `GITHUB_TOKEN` if you hit the unauthenticated GitHub API rate limit (common behind a shared
egress IP); the script sends it as a bearer token when present.

The installer refuses to finish if the downloaded binary's checksum does not match, or if the
installed binary does not report the version you asked for. Upgrading over a running `omp.exe` works
— Windows will not overwrite a running image, so the old binary is renamed aside first.

If another omp is earlier on `PATH` (an upstream install, typically at `%LOCALAPPDATA%\omp`), the
script warns. That one keeps winning until you remove it.

## Linux (x64)

```sh
TAG=$(curl -fsSL https://api.github.com/repos/arynyklas/oh-my-pi/releases \
  | grep -o '"tag_name": *"v[0-9.]*-fork\.[0-9]*"' | head -1 | cut -d'"' -f4)
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/arynyklas/oh-my-pi/releases/download/$TAG/omp-linux-x64"
curl -fsSLO "https://github.com/arynyklas/oh-my-pi/releases/download/$TAG/SHA256SUMS"
grep ' omp-linux-x64$' SHA256SUMS | sha256sum -c -
sudo install -m 0755 omp-linux-x64 /usr/local/bin/omp
omp --version
```

Never skip the `sha256sum -c` step — it is the only integrity gate on a manual install.

## Verify

```console
$ omp --version
omp/17.2.15-fork.1

$ omp --smoke-test
smoke-test: ok
```

`--smoke-test` spawns the stats-sync worker and the tiny-model subprocess and pings them. It is what
catches a broken worker entrypoint or a bad natives embed, so run it after a manual install.

## Updating

Once you are on a `-fork.N` build, the built-in updater stays on the fork's release line:

```sh
omp update --check
omp update
```

`isForkVersion()` (`packages/coding-agent/src/cli/release-info.ts`) tests for the literal `-fork.`
marker in the running version. When present, `omp update` queries
`arynyklas/oh-my-pi`; otherwise it falls back to upstream.

### Migrating off the retired `-authgw.beta.N` line

Fork builds before `17.2.15-fork.1` used `X.Y.Z-authgw.beta.N` tagged
`auth-gateway-vX.Y.Z-beta.N`, published as GitHub **prereleases**. Those version strings have no
`-fork.` marker, so `omp update` routes them to `can1357/oh-my-pi`, which never publishes fork tags.
**A build on the old line can never see the new one and will silently report itself up to date.**

The fix is one manual binary replacement — rerun the Windows installer, or redo the Linux steps
above. After that `omp update` works normally.

Check which line you are on:

```sh
omp --version   # ...-fork.N  -> current;  ...-authgw.beta.N -> replace by hand
```

## Auth gateway as a service

If you are installing the fork to run the [auth gateway](auth-broker-gateway.md) headlessly, the
same binary serves both units. A working systemd layout:

```ini
# /etc/systemd/system/omp-auth-broker.service
[Unit]
Description=Oh My Pi auth broker credential vault
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=omp-gateway
Group=omp-gateway
WorkingDirectory=/var/lib/omp-gateway
Environment=HOME=/var/lib/omp-gateway
ExecStart=/usr/local/bin/omp auth-broker serve --bind=127.0.0.1:8765
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/omp-auth-gateway.service
[Unit]
Description=Oh My Pi LLM auth gateway
After=network-online.target omp-auth-broker.service
Wants=network-online.target
Requires=omp-auth-broker.service
[Service]
Type=simple
User=omp-gateway
Group=omp-gateway
WorkingDirectory=/var/lib/omp-gateway
Environment=HOME=/var/lib/omp-gateway
Environment=OMP_AUTH_BROKER_URL=http://127.0.0.1:8765
ExecStart=/usr/local/bin/omp auth-gateway serve --bind=0.0.0.0:4000
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

State lives in `$HOME/.omp` — `auth-gateway.db` (users, tokens, pools, ACLs) and
`auth-gateway.token` (the bearer token, mode 0600).

Upgrading a deployed gateway:

```sh
# 1. back up state and the current binary
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/omp-upgrade-backups
tar -czf /root/omp-upgrade-backups/omp-gateway-data-$TS.tar.gz -C /var/lib/omp-gateway .omp
cp -a /usr/local/bin/omp /root/omp-upgrade-backups/omp-$(/usr/local/bin/omp --version | cut -d/ -f2)

# 2. download + verify (see the Linux section)

# 3. swap and restart -- broker first, it is a Requires= of the gateway
systemctl stop omp-auth-gateway.service omp-auth-broker.service
install -m 0755 -o root -g root ./omp-linux-x64 /usr/local/bin/omp
systemctl start omp-auth-broker.service && sleep 3
systemctl start omp-auth-gateway.service
```

Then verify — the health endpoint reports the serving binary's version:

```console
$ curl -s http://127.0.0.1:4000/healthz
{"ok":true,"version":"17.2.15-fork.1"}
```

Only `GET /healthz` is unauthenticated; a `HEAD` returns 401, so point uptime monitors at `GET`.
Confirm the state survived the upgrade with the admin status endpoint, which wraps its payload under
`status`:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/v1/admin/status
```

and probe the upstream credentials:

```sh
sudo -u omp-gateway env HOME=/var/lib/omp-gateway OMP_AUTH_BROKER_URL=http://127.0.0.1:8765 \
  omp auth-gateway check --json
```

The `Version:` line in the `/gateway` console Overview is this same server-side value. It is the
remote gateway's build, not the version of the omp you are running locally and not a "latest
available" lookup — a stale number there means the server binary is old.

## Build from source

Required for macOS, ARM, and musl, since those artifacts are not published.

```sh
git clone https://github.com/arynyklas/oh-my-pi.git
cd oh-my-pi                      # already on release/fork
bun install
bun run build
```

Run it in place with `bun run packages/coding-agent/src/cli.ts`, or link it onto `PATH` with
`scripts/link-omp.sh`. Building the distributable binaries instead uses
`bun scripts/ci-release-build-binaries.ts --targets <target>`; that path needs the prebuilt natives
addons in `packages/natives/native/`.

## Uninstall

**Windows** — delete the install directory and drop it from `PATH`:

```powershell
Remove-Item -Recurse -Force $env:LOCALAPPDATA\omp
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", (($p -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne "$env:LOCALAPPDATA\omp" }) -join ';'), "User")
```

**Linux** — `sudo rm /usr/local/bin/omp`.

Neither removes your profile at `~/.omp`, which holds sessions, settings, credentials, and gateway
connection profiles. Delete it separately if you want a clean slate.
