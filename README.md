<div align="center">
  <img width="396" height="136" alt="Screenshot 2026-05-03 161435" src="https://github.com/user-attachments/assets/46530e1a-d178-4fcf-8d07-99055ff53072" />
</div>

# SteamWindowsToastNotification

SteamWindowsToastNotification replaces Steam desktop popup notifications with native Windows notifications.

## Features

- Replaces Steam's desktop notification popups with native Windows notifications.
- Supports common Steam notifications such as friend messages, group chat messages, friend online alerts, voice chat requests, game invites, download complete alerts, and tutorial prompts.
- Shows Steam notification actions as Windows notification buttons where available, such as opening chat, joining a game, or dismissing a call.
- Includes settings for enabling the bridge, hiding Steam's original popup, and controlling Do Not Disturb priority behavior.

## Windows Support Policy

This plugin primarily tested and optimized for Windows 11 25h2, while remaining compatible with Windows 10 64-bit version 1607 or later where possible.

**Supported:**
- Recommended: Windows 11 22H2 or later (recommended)
- Minimum supported: Windows 10 64-bit version 1607 or later

Older or unsupported Windows versions may have compatibility issues with this plugin.

## Prerequisites

- [Millennium](https://github.com/SteamClientHomebrew/Millennium)
- Windows 10 64-bit version 1607 or later, or Windows 11 22H2 or later (recommended)

## Architecture

Notifications are rendered by a small native helper, `backend/bin/toast-helper.exe`, written in Rust against the `windows` crate:

- The Lua backend builds the toast XML and writes it to the helper over stdin. Notification text is never interpolated into a script, so names and messages containing `$`, quotes, or newlines are just data.
- The helper loads WinRT once per toast and exits immediately. No PowerShell, execution policy, or temporary script is involved in the normal path.
- If the helper is missing, the backend falls back to `backend/bin/toast-fallback.ps1`, which reads the XML from a file instead of embedding it in a script.
- The helper also registers the `Steam` AppUserModelID shortcut once at startup and extracts Steam's icon for generic notifications.

## Development

Node.js 18+ and a Rust toolchain with the MSVC target are needed if you want to build the plugin from source.

```ps1
npm install
npm run dev
```

`npm run dev` and `npm run build` compile `native/` and copy the helper to `backend/bin/toast-helper.exe` before running Millennium's build.

Use the built plugin from this workspace in your Millennium plugins directory.

## Build

```ps1
npm run build
```

## Safety Rules

- Notification XML is passed to the native helper as data over stdin. It is never evaluated as a script, and the text is XML-escaped before it reaches Windows.
- The PowerShell fallback reads the XML from a file and uses a fixed script with no string interpolation.
- Only standard links such as `steam://`, `http://`, and `https://` are allowed as notification actions.
- The plugin avoids executing user-provided content. Notification handling stays local, except that avatar/icon URLs exposed by Steam may be fetched so Windows can display the same image.
