# webterm

A password-protected terminal in your browser. xterm.js runs in the page, node-pty runs a real shell on the server, and a WebSocket connects them. Works on desktop and mobile, keeps your shell running while you're away (shared across tabs and devices), and can upload and download files.

## Quick start

```sh
npx @quincyhuang/webterm                      # http://127.0.0.1:2828
```

The first time, there's no login yet, so webterm prints a one-time setup link. Open it to choose your username and password, and you're signed in.

Or install it globally to get a `webterm` command:

```sh
npm install -g @quincyhuang/webterm
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

The service commands are Linux-only (systemd). On macOS and Windows, `install-service` and `uninstall-service` stop with an error; run `webterm` directly, or use your platform's service manager.

To keep webterm running in the background, start it at boot and restart it if it crashes, install it as a systemd **user** service. It runs as you, with no root needed:

```sh
npm install -g @quincyhuang/webterm      # a stable install path (not the npx cache)
cd ~/webterm                              # optional: a directory with your .env
webterm install-service --host 0.0.0.0 --port 2828
```

From a clone of this repository, use `npm run install-service -- --host 0.0.0.0` instead.

- **Options:** server options you pass (`--host`, `--port`, `--config`, ...) are saved in the service. The service runs in the current directory, so a `.env` file there is used too. The shell is pinned to your current one.
- **Before installing,** the login is checked: a broken one fails right away instead of looping. If there's no login yet, the service starts in setup mode, and its one-time setup link appears in the output (and later in `journalctl --user -u webterm`).
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
-c, --config <path>   settings file: login and app settings
                                            (env WEBTERM_CONFIG,
                                            default ~/.config/webterm/settings.json)
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
- **New shell for each tab:** every tab gets its own shell. It ends when the tab is closed (or reloaded) or you log out. If the tab loses its connection instead, its shell waits 2 minutes for it to come back.

Type `exit` to end a shell. For the shared shell, that ends it in every tab, and pressing Enter starts a new one. A shared shell with no tabs open is ended after 7 days; change this with `--shell-timeout`. Restarting the server ends all shells.

## Color themes

Pick a theme in the ⚙ settings menu under **Theme**. It offers the 900+ schemes from [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT). The default is Ghostty's built-in color scheme.

- **Finding one:** search by name, filter by dark or light, and hover or use ↑/↓ to preview it live on your terminal. Click or press Enter to choose; Esc or ✕ closes the picker and drops any preview.
- **Follow system light/dark:** keeps one light and one dark theme and switches with your OS appearance.
- **Everything follows the theme:** the header, menus, panels and the login page take their colors from the chosen terminal palette, with contrast checks so text stays readable.
- **Saved per browser,** like text size. The page applies it before it first draws, so there's no flash of the default colors.
- **Bundled:** the schemes ship in `public/themes.json`, so webterm never contacts GitHub. To refresh them from upstream, run `npm run update-themes`.

## Cursor

Choose the cursor in the ⚙ settings menu (saved per browser):

- **Block** (default): a solid rectangle over the character.
- **Bar:** a thin line between characters.
- **Underline:** a line under the character.
- **Hollow:** an outlined rectangle.

Programs can still change the cursor while they run; vim's insert-mode bar, for example. With **Hollow** selected, a program that asks for a block cursor gets the hollow one.

## Copy and paste

Select text with the mouse, then:

- **Ctrl+Shift+C** copies (on macOS, **Cmd+C**).
- **Ctrl+C** copies when text is selected, and clears the selection, so pressing it again interrupts the program as usual. With nothing selected, it interrupts as always. (On macOS, Ctrl+C always goes to the terminal.)
- **Ctrl+Insert** and the right-click menu's **Copy** also work.
- Paste with **Ctrl+Shift+V** (on macOS, **Cmd+V**) or the right-click menu. Like most Linux terminals, plain **Ctrl+V** goes to the program (in shells it inserts the next key literally).

**Programs that capture the mouse** (Claude Code, vim with `mouse=a`, tmux mouse mode, htop): dragging goes to the program.
- Many of them copy what you select themselves, using the OSC 52 escape sequence: Claude Code does this by default, as do vim/neovim and tmux with `set-clipboard on`. webterm puts that text on your clipboard and shows "Copied". Over plain HTTP the browser only allows this right after a click or key press; if it refuses (Safari is strict about this), a **Click to copy** message appears, and one click finishes the copy. Only the tab you're using copies. Programs can write to the clipboard this way, but never read it.
- To make a normal terminal selection over such a program instead, hold **Shift** while dragging (on macOS, **Option**).

On phones and tablets, tap **Select** in the extra-keys bar, drag across the text (or tap a word), then tap **Copy**. Outside select mode, swiping scrolls as usual.

**Scrolling on touch screens:** swipe to scroll. In the normal shell this scrolls the history. In full-screen programs that handle the mouse (Claude Code, vim with `mouse=a`, tmux, htop), a swipe sends mouse-wheel scrolling, like a desktop wheel, so they scroll their own view. In full-screen programs without mouse support (`less`, `man`), it sends ↑/↓ instead.

Copying works over plain HTTP too: webterm falls back to the older copy mechanism when the browser's clipboard API isn't available. Pasting with the **Paste** key needs that API, so over plain HTTP it asks you to paste into a box instead.

## Flaky connections

- **Automatic reconnect:** when the connection drops, webterm reconnects on its own, retrying with growing delays (up to 30 s apart). It also retries immediately when you return to the tab, or when the browser reports the network is back. The shell keeps running on the server meanwhile, and its screen is restored exactly. Keys typed while disconnected are discarded; pressing Enter retries right away.
- **Dead connections are detected:** a connection that goes silent without closing (switching networks, a phone waking up) is noticed within about 45 s in the browser and 30 s on the server, using heartbeats every 15 s.
- **Compression:** terminal output is compressed, which helps a lot on slow links.

## Terminal bell

When a program rings the bell (`printf '\a'`, or a tool that beeps when it's done), the terminal briefly flashes. With reduced motion turned on, it shows an outline instead. If you're looking at another tab or window, the page title gets a 🔔 until you come back, so you can spot which tab wants attention. Turn on **Bell sound** in the ⚙ settings menu for a short beep too. It's off by default, and with the shared shell only one tab beeps. This works over plain HTTP: it doesn't use browser notifications, which require HTTPS.

## Push notifications (ntfy)

webterm can send push notifications to your phone or desktop through [ntfy](https://ntfy.sh), using the ntfy apps or any ntfy subscriber. The **server** sends them, so they work over plain HTTP and even when no browser tab is open. That's handy with the shared shell: start a long job, close the laptop, and get a ping when it's done.

Set it up in the app: open the ⚙ settings menu, go to **Push notifications**, and:

1. Click **New** to generate a random ntfy.sh topic, or enter your own topic URL (for example from a self-hosted server). On ntfy.sh, anyone who knows the topic name can read it, so treat it like a password.
2. Subscribe to that topic in the ntfy app on your phone or desktop.
3. Optionally, add an access token for a protected topic, and turn on **Also notify on the terminal bell**.
4. Click **Save**, then **Send test**.

The settings apply immediately, with no restart. They're saved on the server in `settings.json` (default `~/.config/webterm/settings.json`, or `--config`), readable only by you, and shared by every browser. The token is never sent back to the browser. To turn notifications off, clear the topic URL and save.

Programs trigger a notification with one of the standard escape sequences:

```sh
printf '\e]9;build finished\a'                  # OSC 9 (iTerm2 style)
printf '\e]777;notify;Deploy;all green\a'       # OSC 777 (title + body)
make && printf '\e]9;make ok\a' || printf '\e]9;make FAILED\a'
```

Kitty's OSC 99 also works, and some tools emit these sequences on their own. Plain bells (`\a`) only trigger a push if **Also notify on the terminal bell** is on, since shells beep on every failed completion.

- **When it pushes:** only when nobody is looking at that shell (no tab visible and focused). At most one push goes out every 5 seconds; extra ones are counted into the next.
- **What's sent:** the notification text and the terminal's title, never terminal output. Tapping the notification opens webterm.
- **Self-hosting:** a [self-hosted ntfy server](https://docs.ntfy.sh/install/) keeps everything on your network; enter its topic URL instead. Notifications to iOS from a self-hosted server need extra setup; see the ntfy docs.

## Files

The folder button in the header opens a file browser that starts in your terminal's current directory.

- **Download:** tap a file.
- **Upload:** use the Upload button, or drag files anywhere onto the page. Files go into the directory being shown.
- **Existing files** are never replaced without asking.
- **Partial files:** uploads are written to a temporary file and renamed into place, so a failed or cancelled upload leaves nothing behind.

Files are read and written with the permissions of the user running webterm, the same as the shell. Finding the terminal's directory works on Linux and macOS; elsewhere the browser starts in your home directory.

## Credentials

The login is read from (first match wins):

1. **Environment variables:** `WEBTERM_USER` and `WEBTERM_PASSWORD_HASH` (for example from a `.env` file)
2. **`settings.json`:** the `auth` section, in `~/.config/webterm/settings.json` (or the file given by `--config` / `WEBTERM_CONFIG`). This is where the setup page and `set-password` save it.

**First run:** with no login anywhere, webterm starts in setup mode and prints a one-time link:

```
No login is set up yet. Create one with this one-time link:
  http://127.0.0.1:2828/setup#t=kJeuHlOXAHsScTHglDhmQ-mxhc0GXnhI
```

Open it to choose a username and password (at least 8 characters). webterm saves the login in `settings.json` and signs you in; no restart is needed.

- **Only the link works:** until then, nothing else is reachable. The page needs the link's secret code, so someone else who finds the server first can't claim it.
- **Wrong codes count as failed logins** toward the lockout.
- **The code stays out of logs:** it's in the part of the URL after `#`, which browsers never send to the server.
- **As a service:** the link is in its log, at `journalctl --user -u webterm`. If you open the setup page without it, you can paste the code instead.

You can also set the login from the command line. Password hashes are scrypt, in the form `scrypt$<salt>$<hash>`:

```sh
webterm set-password alice            # prompt, then save to settings.json (mode 600)
webterm set-password alice --print    # prompt, then print WEBTERM_USER / WEBTERM_PASSWORD_HASH lines
echo 'secret pw' | webterm set-password alice   # non-interactive
```

Restart the server after changing the login with `set-password`. Sessions are held in memory, so a restart logs everyone out; otherwise they last 1 day. After 5 failed logins, an IP address is locked out for 15 minutes.

## Development

```sh
git clone https://github.com/quincyyhuang/webterm.git && cd webterm
npm install
npm start   # prints a setup link the first time
```

## Security notes

- Logging in gives a full shell as the user running the server.
- The server speaks plain HTTP, so the password and session cookie cross the network unencrypted. It binds to `127.0.0.1` by default. Before using `--host` to expose it, put it behind an HTTPS reverse proxy that sets `X-Forwarded-Proto: https` (the cookie is then marked `Secure`), or reach it through an SSH tunnel or VPN.

## License

MIT. See [LICENSE](LICENSE).
