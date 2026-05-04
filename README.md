<div align="center">
  <img width="396" height="136" alt="Screenshot 2026-05-03 161435" src="https://github.com/user-attachments/assets/46530e1a-d178-4fcf-8d07-99055ff53072" />
</div>

# Steam Native Windows Notifications

Steam Native Windows Notifications plugin that replaces Steam desktop popup notifications with native Windows notifications.

## Features

- Replaces Steam's desktop notification popups with native Windows notifications.
- Supports common Steam notifications such as friend messages, group chat messages, friend online alerts, voice chat requests, game invites, download complete alerts, and tutorial prompts.
- Shows Steam notification actions as Windows notification buttons where available, such as opening chat, joining a game, or dismissing a call.
- Includes settings for enabling the bridge, controlling popup suppression, Hide Steam's original popup and Do Not Disturb priority behavior.

## Windows Support Policy

This plugin primarily tested and optimized for Windows 11 25h2, while remaining compatible with Windows 10 64-bit version 1607 or later where possible.

**Supported:**
- Recommended: Windows 11 22H2 or later (recommended)
- Minimum supported: Windows 10 64-bit version 1607 or later

Older or unsupported Windows versions may have compatibility issues with this plugin.

## Prerequisites

- [Millennium](https://github.com/SteamClientHomebrew/Millennium)
- Windows 10 64-bit version 1607 or later, or Windows 11 22H2 or later (recommended)

## Development

Node.js 18+ is needed if you want to build the plugin from source.

```ps1
npm install
npm run dev
```

Use the built plugin from this workspace in your Millennium plugins directory.

## Build

```ps1
npm run build
```

## Safety Rules

- This plugin keeps things simple and safe by limiting what actions notifications can launch. Only standard links such as steam://, http://, and https:// are supported.
- All XML content is escaped before the toast payload is created to avoid malformed notifications or unexpected behavior.
- The plugin avoids executing any user-provided PowerShell commands. Notification handling stays local, except that notification avatar/icon URLs exposed by Steam may be fetched so Windows can display the same image.
