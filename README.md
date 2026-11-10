# webterm

A password-protected terminal in your browser. xterm.js runs in the page, node-pty runs a real shell on the server, and a WebSocket connects them. Works on desktop and mobile, keeps your shell running while you're away (shared across tabs and devices), and can upload and download files.

## Quick start

```sh
npx @quincyyhuang/webterm set-password alice   # prompts for a password
npx @quincyyhuang/webterm                      # http://127.0.0.1:2828
```

Or install it globally to get a `webterm` command:

```sh
npm install -g @quincyyhuang/webterm
webterm set-password alice
webterm --host 0.0.0.0 --port 2828
```

## Installing

webterm depends on [node-pty](https://github.com/microsoft/node-pty), which has a native module:

- **Linux:** node-pty is compiled during install, so you need `python3`, `make` and a C++ compiler (for example `sudo apt install build-essential python3`). macOS and Windows use prebuilt binaries.
- **npm 11** prints an `install-scripts` warning for node-pty. That is expected, and the script still runs. If your npm is configured to skip install scripts (for example `ignore-scripts=true`), webterm will report that node-pty failed to load. Allow the script and reinstall:

  ```sh
  npm install-scripts approve node-pty
  ```

Requires Node.js 20.12 or newer.

## Running as a service (Linux)

To keep webterm running in the background, start it at boot and restart it if it crashes, install it as a systemd **user** service. It runs as you, with no root needed:

```sh
npm install -g @quincyyhuang/webterm      # a stable install path (not the npx cache)
cd ~/webterm                              # optional: a directory with your .env
webterm install-service --host 0.0.0.0 --port 2828
```

From a clone of this repository, use `npm run install-service -- --host 0.0.0.0` instead.

- **Options:** server options you pass (`--host`, `--port`, `--config`, ...) are saved in the service. The service runs in the current directory, so a `.env` file there is used too. The shell is pinned to your current one.
- **Before installing,** credentials are checked, so a broken setup fails right away instead of looping.
- **Lingering** is enabled if possible, so the service starts at boot and keeps running after you log out. See [Lingering](#lingering-keep-it-running-when-youre-logged-out) below.
- **If the address isn't ready** (for example, at boot, before DHCP), the service retries every 5 seconds.
- **Preview:** `--dry-run` prints the unit file without installing anything. `--name` picks a different unit name, so you can run several instances.

```sh
systemctl --user status webterm       # state
journalctl --user -u webterm -f       # logs
systemctl --user restart webterm      # after changing credentials, .env, or upgrading
webterm uninstall-service             # stop and remove it
```

Running `install-service` again updates the existing service.

### Lingering: keep it running when you're logged out

systemd normally starts a user's services when they log in and stops them when they log out. To have webterm start at boot and keep running while you're logged out, **lingering** must be enabled for your user. `install-service` tries to turn it on for you, but some systems require admin rights. Check it and enable it yourself with:

```sh
loginctl show-user "$USER" -p Linger    # Linger=yes means it's on
sudo loginctl enable-linger "$USER"     # turn it on
```

Without lingering, webterm only runs while you have a login session open (a desktop session or an SSH connection), and stops when the last one ends. To undo it, run `sudo loginctl disable-linger "$USER"`. That also stops your other user services from running while you're logged out.

## Usage

```
webterm [options]                         start the server
webterm set-password <username> [--print] create credentials
webterm install-service [options]         run as a systemd user service
webterm uninstall-service [--name <n>]    stop and remove that service

-H, --host <addr>     address to bind      (env WEBTERM_HOST, default 127.0.0.1)
-p, --port <port>     port to listen on    (env WEBTERM_PORT, default 2828)
-s, --shell <path>    shell to run         (env WEBTERM_SHELL or SHELL)
-c, --config <path>   credentials file     (env WEBTERM_CONFIG,
                                            default ~/.config/webterm/config.json)
    --max-upload <MB> per-file upload limit (env WEBTERM_MAX_UPLOAD_MB,
                                            default 1024; 0 = unlimited)
    --shell-timeout <hours>
                      end the shared shell after this long with no tabs open
                                           (env WEBTERM_SHELL_TIMEOUT_HOURS,
                                            default 168 = 7 days; 0 = never)
```

Command-line options override environment variables. A `.env` file in the current directory is loaded automatically, but variables already set in the environment take precedence over it.

## Shells

There are two modes, chosen with **New shell for each tab** in the ⚙ settings menu. The setting is saved per browser and applies to tabs opened after you change it.

- **Shared shell (default):** there is one shell. Every tab, on any browser or device, shows that same shell live, so typing in one tab shows up in the others. Closing tabs or logging out leaves it running. When you come back, the screen, scrollback and any running program (even full-screen ones like `vim` or `less`) are restored exactly as you left them. The terminal size follows the tab you're actively using.
- **New shell for each tab:** every tab gets its own shell. It ends when the tab is closed (or reloaded) or you log out.

Type `exit` to end a shell. For the shared shell, that ends it in every tab, and pressing Enter starts a new one. A shared shell with no tabs open is ended after 7 days; change this with `--shell-timeout`. Restarting the server ends all shells.

## Files

The folder button in the header opens a file browser that starts in your terminal's current directory.

- **Download:** tap a file.
- **Upload:** use the Upload button, or drag files anywhere onto the page. Files go into the directory being shown.
- **Existing files** are never replaced without asking.
- **Partial files:** uploads are written to a temporary file and renamed into place, so a failed or cancelled upload leaves nothing behind.

Files are read and written with the permissions of the user running webterm, the same as the shell. Finding the terminal's directory works on Linux and macOS; elsewhere the browser starts in your home directory.

## Credentials

The server will not start without credentials. They are read from (first match wins):

1. **Environment variables:** `WEBTERM_USER` and `WEBTERM_PASSWORD_HASH`
2. **Config file:** `{ "username": "...", "passwordHash": "..." }` at `~/.config/webterm/config.json` (or `--config` / `WEBTERM_CONFIG`). See `config.example.json`.

Password hashes are scrypt, in the form `scrypt$<salt>$<hash>`:

```sh
webterm set-password alice            # prompt, then write the config file (mode 600)
webterm set-password alice --print    # prompt, then print WEBTERM_USER / WEBTERM_PASSWORD_HASH lines
echo 'secret pw' | webterm set-password alice   # non-interactive
```

Restart the server after changing credentials. Sessions are held in memory, so a restart logs everyone out; otherwise they last 1 day. After 5 failed logins, an IP address is locked out for 15 minutes.

## Development

```sh
git clone https://github.com/quincyyhuang/webterm.git && cd webterm
npm install
npm run set-password -- alice
npm start
```

## Security notes

- Logging in gives a full shell as the user running the server.
- The server speaks plain HTTP, so the password and session cookie cross the network unencrypted. It binds to `127.0.0.1` by default. Before using `--host` to expose it, put it behind an HTTPS reverse proxy that sets `X-Forwarded-Proto: https` (the cookie is then marked `Secure`), or reach it through an SSH tunnel or VPN.

## License

MIT. See [LICENSE](LICENSE).
