local logger = require("logger")
local millennium = require("millennium")
local ffi = require("ffi")

math.randomseed(os.time())

local MAX_TITLE_LENGTH = 128
local MAX_BODY_LENGTH = 512
local MAX_ACTION_LABEL_LENGTH = 64
local FIELD_SEPARATOR = string.char(31)
local TOAST_APP_ID = "Steam"
local ICON_PLACEHOLDER = "__STEAM_NATIVE_TOAST_ICON__"
local DEBUG_MODE = os.getenv("STEAM_NATIVE_TOASTS_DEBUG") == "1"

ffi.cdef[[
typedef void* HANDLE;
typedef void* LPVOID;
typedef const wchar_t* LPCWSTR;
typedef wchar_t* LPWSTR;
typedef unsigned long DWORD;
typedef int BOOL;
typedef unsigned short WORD;

typedef struct {
    DWORD cb;
    LPWSTR lpReserved;
    LPWSTR lpDesktop;
    LPWSTR lpTitle;
    DWORD dwX;
    DWORD dwY;
    DWORD dwXSize;
    DWORD dwYSize;
    DWORD dwXCountChars;
    DWORD dwYCountChars;
    DWORD dwFillAttribute;
    DWORD dwFlags;
    WORD wShowWindow;
    WORD cbReserved2;
    unsigned char* lpReserved2;
    HANDLE hStdInput;
    HANDLE hStdOutput;
    HANDLE hStdError;
} STARTUPINFOW;

typedef struct {
    HANDLE hProcess;
    HANDLE hThread;
    DWORD dwProcessId;
    DWORD dwThreadId;
} PROCESS_INFORMATION;

BOOL __stdcall CreateProcessW(
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPVOID lpProcessAttributes,
    LPVOID lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    STARTUPINFOW* lpStartupInfo,
    PROCESS_INFORMATION* lpProcessInformation
);
DWORD __stdcall WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);
BOOL __stdcall GetExitCodeProcess(HANDLE hProcess, DWORD* lpExitCode);
BOOL __stdcall CloseHandle(HANDLE hObject);
DWORD __stdcall GetLastError(void);
]]

local kernel32 = ffi.load("kernel32")

local STARTF_USESHOWWINDOW = 0x00000001
local CREATE_NO_WINDOW = 0x08000000
local INFINITE = 0xFFFFFFFF
local SW_HIDE = 0
local SW_SHOWNORMAL = 1

local function file_exists(path)
    if type(path) ~= "string" or path == "" then
        return false
    end

    local handle = io.open(path, "rb")
    if not handle then
        return false
    end

    handle:close()
    return true
end

local function xml_escape(value)
    if type(value) ~= "string" then
        return ""
    end

    return value
        :gsub("&", "&amp;")
        :gsub("<", "&lt;")
        :gsub(">", "&gt;")
        :gsub('"', "&quot;")
        :gsub("'", "&apos;")
end

local function sanitize_text(value, max_length)
    if type(value) ~= "string" then
        return ""
    end

    local sanitized = value:gsub("[%z\1-\8\11\12\14-\31]", " ")
    if #sanitized > max_length then
        sanitized = sanitized:sub(1, max_length)
    end

    return sanitized
end

local function simple_hash(value)
    if type(value) ~= "string" or value == "" then
        return "0"
    end

    local hash = 5381
    for index = 1, #value do
        hash = (hash * 33 + string.byte(value, index)) % 4294967296
    end

    return string.format("%08X", hash)
end

local function summarize_log_text(value, max_length)
    local sanitized = sanitize_text(value or "", max_length or MAX_BODY_LENGTH)
    if DEBUG_MODE then
        return sanitized
    end

    return "[redacted len="
        .. tostring(#sanitized)
        .. " hash="
        .. simple_hash(sanitized)
        .. "]"
end

local function sanitize_trace_message_for_logging(message)
    local sanitized = sanitize_text(message or "", 400)
    if DEBUG_MODE then
        return sanitized
    end

    sanitized = sanitized:gsub("title=(.-) body=", function(title_value)
        return "title=" .. summarize_log_text(title_value, MAX_TITLE_LENGTH) .. " body="
    end)
    sanitized = sanitized:gsub("body=(.+)$", function(body_value)
        return "body=" .. summarize_log_text(body_value, MAX_BODY_LENGTH)
    end)

    return sanitized
end

local function normalize_windows_path(value)
    if type(value) ~= "string" then
        return nil
    end

    local normalized = value:match("^%s*(.-)%s*$")
    if normalized == "" then
        return nil
    end

    normalized = normalized:gsub('^"(.*)"$', "%1"):gsub("/", "\\")
    normalized = normalized:gsub("\\+$", "")
    return normalized
end

local function parent_directory(path)
    local normalized = normalize_windows_path(path)
    if not normalized then
        return nil
    end

    return normalized:match("^(.*)\\[^\\]+$")
end

local function join_windows_path(base, child)
    local normalized_base = normalize_windows_path(base)
    if not normalized_base or type(child) ~= "string" or child == "" then
        return nil
    end

    return normalized_base .. "\\" .. child
end

local function add_steam_exe_candidate(candidates, path, source)
    local normalized = normalize_windows_path(path)
    if normalized and file_exists(normalized) then
        -- Only keep paths Lua can open. PowerShell gets a finished answer,
        -- not a list of guesses to resolve during toast delivery.
        table.insert(candidates, { path = normalized, source = source })
    end
end

local function add_steam_dir_candidate(candidates, dir, source)
    add_steam_exe_candidate(candidates, join_windows_path(dir, "Steam.exe"), source)
end

local function add_script_location_candidate(candidates)
    local ok, info = pcall(debug.getinfo, 1, "S")
    local source = ok and info and info.source or nil
    if type(source) ~= "string" or source:sub(1, 1) ~= "@" then
        return
    end

    -- Installed layout:
    -- %steam%\millennium\plugins\steam-native-toasts\backend\main.lua
    local backend_dir = parent_directory(source:sub(2))
    local plugin_dir = parent_directory(backend_dir)
    local plugins_dir = parent_directory(plugin_dir)
    local millennium_dir = parent_directory(plugins_dir)
    local steam_dir = parent_directory(millennium_dir)
    add_steam_dir_candidate(candidates, steam_dir, "plugin_path")
end

-- Resolve Steam from Millennium/Lua, not from the PowerShell toast script.
-- The previous PowerShell shortcut/registry resolver was fragile at startup,
-- so new discovery sources should be added here and guarded with pcall.
local function resolve_steam_exe_path()
    local candidates = {}

    -- SteamBrew exposes the Steam install directory; this avoids hardcoding
    -- the user's drive while keeping PowerShell out of path discovery.
    local ok, steam_path = pcall(millennium.steam_path)
    if ok then
        add_steam_dir_candidate(candidates, steam_path, "millennium.steam_path")
    else
        logger:info("steam_path unavailable: " .. summarize_log_text(tostring(steam_path), 120))
    end

    local install_ok, install_path = pcall(millennium.get_install_path)
    if install_ok then
        add_steam_dir_candidate(candidates, install_path, "millennium.get_install_path")
        add_steam_dir_candidate(candidates, parent_directory(install_path), "millennium.get_install_path_parent")
    end

    add_script_location_candidate(candidates)
    add_steam_dir_candidate(candidates, os.getenv("STEAM_PATH"), "env.STEAM_PATH")
    add_steam_dir_candidate(candidates, os.getenv("STEAM_DIR"), "env.STEAM_DIR")
    add_steam_exe_candidate(candidates, "C:\\Program Files (x86)\\Steam\\Steam.exe", "default_install")

    local selected = candidates[1]
    if selected then
        logger:info(
            "resolved_steam_exe source="
                .. sanitize_text(selected.source, 60)
                .. " path="
                .. summarize_log_text(selected.path, 160)
        )
        return selected.path
    end

    logger:info("resolved_steam_exe source=none")
    return nil
end

local function sanitize_protocol_url(url)
    if type(url) ~= "string" then
        return nil
    end

    local normalized = url:match("^%s*(.-)%s*$")
    if normalized == "" then
        return nil
    end

    local lowered = normalized:lower()
    if lowered:match("^steam://") or lowered:match("^https?://") then
        return normalized
    end

    return nil
end

local function sanitize_icon_source(icon)
    if type(icon) ~= "string" then
        return nil
    end

    local normalized = icon:match("^%s*(.-)%s*$")
    if normalized == "" then
        return nil
    end

    local lowered = normalized:lower()
    if lowered:match("^data:image/") then
        return normalized
    end

    if lowered:match("^https?://") then
        return normalized
    end

    if lowered:match("^file://") then
        return normalized
    end

    if normalized:match("^[A-Za-z]:\\") then
        return normalized
    end

    return nil
end

local function write_file(path, content, utf8_bom)
    local file = io.open(path, "wb")
    if not file then
        return false
    end

    if utf8_bom then
        file:write(string.char(0xEF, 0xBB, 0xBF))
    end
    file:write(content)
    file:close()
    return true
end

local function remove_file(path)
    if path and #path > 0 then
        os.remove(path)
    end
end

local function to_wide(value)
    local text = tostring(value or "")
    local buffer = ffi.new("wchar_t[?]", #text + 1)
    for i = 1, #text do
        buffer[i - 1] = string.byte(text, i)
    end
    buffer[#text] = 0
    return buffer
end

local function run_hidden_process(executable, arguments)
    local startup_info = ffi.new("STARTUPINFOW")
    startup_info.cb = ffi.sizeof(startup_info)
    startup_info.dwFlags = STARTF_USESHOWWINDOW
    startup_info.wShowWindow = DEBUG_MODE and SW_SHOWNORMAL or SW_HIDE

    local process_info = ffi.new("PROCESS_INFORMATION")
    local command_line = '"' .. executable .. '" ' .. arguments
    local creation_flags = DEBUG_MODE and 0 or CREATE_NO_WINDOW

    local created = kernel32.CreateProcessW(
        to_wide(executable),
        to_wide(command_line),
        nil,
        nil,
        0,
        creation_flags,
        nil,
        nil,
        startup_info,
        process_info
    )

    if created == 0 then
        return false, "CreateProcessW failed with error " .. tostring(tonumber(kernel32.GetLastError()))
    end

    kernel32.WaitForSingleObject(process_info.hProcess, INFINITE)

    local exit_code = ffi.new("DWORD[1]", 0)
    if kernel32.GetExitCodeProcess(process_info.hProcess, exit_code) == 0 then
        kernel32.CloseHandle(process_info.hThread)
        kernel32.CloseHandle(process_info.hProcess)
        return false, "GetExitCodeProcess failed with error " .. tostring(tonumber(kernel32.GetLastError()))
    end

    kernel32.CloseHandle(process_info.hThread)
    kernel32.CloseHandle(process_info.hProcess)
    return tonumber(exit_code[0]) == 0, tonumber(exit_code[0])
end

local function os_execute_success(result)
    return result == true or result == 0
end

local function split_blob(blob)
    local fields = {}
    if type(blob) ~= "string" then
        return fields
    end

    local start_index = 1
    while true do
        local separator_index = blob:find(FIELD_SEPARATOR, start_index, true)
        if not separator_index then
            table.insert(fields, blob:sub(start_index))
            break
        end

        table.insert(fields, blob:sub(start_index, separator_index - 1))
        start_index = separator_index + 1
    end

    return fields
end

local function normalize_payload(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8)
    if type(arg1) == "table" and type(arg1.payload_blob) == "string" then
        local fields = split_blob(arg1.payload_blob)
        return {
            typeName = fields[1],
            title = fields[2],
            body = fields[3],
            icon = fields[4],
            launchUrl = fields[5],
            playSound = fields[6] ~= "0",
            actionLabel = fields[7],
            actionUrl = fields[8],
            debugTraceId = fields[9],
            debugSource = fields[10],
            bypassDoNotDisturb = fields[11] == "1"
        }
    end

    if type(arg1) == "string" and arg2 == nil and arg1:find(FIELD_SEPARATOR, 1, true) then
        local fields = split_blob(arg1)
        return {
            typeName = fields[1],
            title = fields[2],
            body = fields[3],
            icon = fields[4],
            launchUrl = fields[5],
            playSound = fields[6] ~= "0",
            actionLabel = fields[7],
            actionUrl = fields[8],
            debugTraceId = fields[9],
            debugSource = fields[10],
            bypassDoNotDisturb = fields[11] == "1"
        }
    end

    return {
        typeName = arg1,
        title = arg2,
        body = arg3,
        icon = arg4,
        launchUrl = arg5,
        playSound = arg6,
        actionLabel = arg7,
        actionUrl = arg8
    }
end

local function build_toast_xml(payload)
    local type_name = sanitize_text(payload.typeName or "General", MAX_TITLE_LENGTH)
    local title = sanitize_text(payload.title or ("Steam: " .. type_name), MAX_TITLE_LENGTH)
    local body = sanitize_text(payload.body or type_name, MAX_BODY_LENGTH)
    local play_sound = payload.playSound ~= false
    local launch_url = sanitize_protocol_url(payload.launchUrl)
    local icon = sanitize_icon_source(payload.icon)
    local is_incoming_voice = type_name == "IncomingVoiceChat"
    local is_friend_online = type_name == "FriendOnline"
    local is_friend_in_game = type_name == "FriendInGame"
    local use_priority_bypass = payload.bypassDoNotDisturb == true
    local scenario_attr = ""

    if use_priority_bypass then
        -- Calls have their own Windows scenario. Using urgent here makes the
        -- buttons behave like a generic priority alert instead of a call.
        if is_incoming_voice then
            scenario_attr = ' scenario="incomingCall"'
        else
            scenario_attr = ' scenario="urgent"'
        end
    end

    if is_friend_online then
        if body == "" and title ~= "" then
            body = title
            title = ""
        elseif title ~= "" and body:lower() == "is now online" then
            body = title .. " " .. body
            title = ""
        end
    end

    local actions = {}
    local action_label = sanitize_text(payload.actionLabel or "Open", MAX_ACTION_LABEL_LENGTH)
    local action_url = sanitize_protocol_url(payload.actionUrl)
    if action_label ~= "" and action_url then
        table.insert(actions, { label = action_label, url = action_url })
    end

    if (not is_friend_online) and #actions == 0 and launch_url then
        actions[1] = { label = "Open", url = launch_url }
    end

    if is_friend_in_game and #actions == 0 then
        actions[1] = { label = "Join", url = "steam://open/friends" }
    end

    logger:info(
        "toast_actions type="
            .. sanitize_text(type_name, 40)
            .. " count="
            .. tostring(#actions)
            .. " primary="
            .. sanitize_text(actions[1] and actions[1].label or "", 40)
    )

    local xml = {}
    local launch_attr = launch_url and (' launch="' .. xml_escape(launch_url) .. '" activationType="protocol"') or ""

    table.insert(xml, '<toast' .. launch_attr .. scenario_attr .. '>')
    table.insert(xml, '<visual>')
    table.insert(xml, '<binding template="ToastGeneric">')

    if icon then
        local icon_source = icon
        if icon:lower():match("^https?://") then
            icon_source = ICON_PLACEHOLDER
        end
        table.insert(xml, '<image placement="appLogoOverride" hint-crop="circle" src="' .. xml_escape(icon_source) .. '"/>')
    end

    if title ~= "" then
        table.insert(xml, '<text>' .. xml_escape(title) .. '</text>')
    end
    if body ~= "" then
        table.insert(xml, '<text>' .. xml_escape(body) .. '</text>')
    end
    table.insert(xml, '</binding>')
    table.insert(xml, '</visual>')

    if #actions > 0 then
        table.insert(xml, '<actions>')
        for _, action in ipairs(actions) do
            table.insert(
                xml,
                '<action content="' .. xml_escape(action.label) .. '" activationType="protocol" arguments="' .. xml_escape(action.url) .. '"/>'
            )
        end
        if is_incoming_voice then
            -- Voice toasts should keep a compact two-button layout:
            -- one app action and one system dismiss action.
            table.insert(
                xml,
                '<action content="Dismiss" activationType="system" arguments="dismiss"/>'
            )
        elseif is_friend_in_game then
            table.insert(
                xml,
                '<action content="Ignore" activationType="system" arguments="dismiss"/>'
            )
        end
        table.insert(xml, '</actions>')
    end

    if not play_sound then
        table.insert(xml, '<audio silent="true"/>')
    end

    table.insert(xml, '</toast>')
    return table.concat(xml)
end

local function show_native_toast(xml, title, body, icon_source)
    logger:info(
        "show_native_toast begin title="
            .. summarize_log_text(title or "", 80)
            .. " body="
            .. summarize_log_text(body or "", 120)
    )
    local temp_dir = os.getenv("TEMP") or os.getenv("TMP") or "."
    local suffix = tostring(os.time()) .. "_" .. tostring(math.random(1000, 9999))
    local ps1_path = temp_dir .. "\\steam_native_toasts_" .. suffix .. ".ps1"
    local log_path = temp_dir .. "\\steam_native_toasts_" .. suffix .. ".log"

    local escaped_ps1_path = ps1_path:gsub("'", "''")
    local escaped_log_path = log_path:gsub("'", "''")
    local escaped_title = sanitize_text(title or "Steam Notification", MAX_TITLE_LENGTH):gsub("'", "''")
    local escaped_body = sanitize_text(body or "You have a new Steam notification.", MAX_BODY_LENGTH):gsub("'", "''")
    local escaped_xml = xml:gsub("'", "''")
    local escaped_icon_source = sanitize_icon_source(icon_source or "") or ""
    escaped_icon_source = escaped_icon_source:gsub("'", "''")
    local steam_exe_path = resolve_steam_exe_path() or ""
    local escaped_steam_exe = steam_exe_path:gsub("'", "''")
    local ps_script = ([[
$ErrorActionPreference = 'Stop'
try {
    $programsPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shortcutPath = Join-Path $programsPath 'Steam.lnk'
    $steamExePath = '%s'
    $legacyShortcutPaths = @(
        (Join-Path $programsPath 'Steam Toast Bridge.lnk'),
        (Join-Path $programsPath 'Steam Native Toasts.lnk')
    )
    # Keep this script focused on Windows toast identity and delivery.
    # Steam path discovery already happened in Lua before this script was built.
    $needsShortcutSetup = (-not [string]::IsNullOrWhiteSpace($steamExePath)) -and (-not (Test-Path -LiteralPath $shortcutPath))
    foreach ($legacyShortcutPath in $legacyShortcutPaths) {
        if (Test-Path -LiteralPath $legacyShortcutPath) {
            Remove-Item -LiteralPath $legacyShortcutPath -Force -ErrorAction SilentlyContinue
            $needsShortcutSetup = $true
        }
    }

    if ($needsShortcutSetup -and -not ('ShortcutHelper' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport]
[Guid("00021401-0000-0000-C000-000000000046")]
class ShellLink {}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
interface IPropertyStore {
    uint GetCount(out uint cProps);
    uint GetAt(uint iProp, out PROPERTYKEY pkey);
    uint GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    uint SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    uint Commit();
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
}

public static class ShortcutHelper {
    public static void EnsureShortcut(string shortcutPath, string exePath, string appId) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(exePath);
        link.SetArguments("");
        link.SetDescription("Steam");
        link.SetIconLocation(exePath, 0);

        var propertyStore = (IPropertyStore)link;
        var appIdKey = new PROPERTYKEY {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };
        var appIdValue = new PROPVARIANT {
            vt = 31,
            pwszVal = Marshal.StringToCoTaskMemUni(appId)
        };

        try {
            uint hr = propertyStore.SetValue(ref appIdKey, ref appIdValue);
            if (hr != 0) Marshal.ThrowExceptionForHR((int)hr);
            hr = propertyStore.Commit();
            if (hr != 0) Marshal.ThrowExceptionForHR((int)hr);
            ((IPersistFile)link).Save(shortcutPath, true);
        } finally {
            if (appIdValue.pwszVal != IntPtr.Zero) {
                Marshal.FreeCoTaskMem(appIdValue.pwszVal);
            }
        }
    }
}
"@
    }

    if ($needsShortcutSetup) {
        [ShortcutHelper]::EnsureShortcut($shortcutPath, $steamExePath, '%s')
    }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

    $xml = @"
%s
"@
    $iconSource = '%s'
    if ($xml.Contains('%s') -and $iconSource.Length -gt 0) {
        if ($iconSource -match '^https?://') {
            $extension = [System.IO.Path]::GetExtension(([Uri]$iconSource).AbsolutePath)
            if ([string]::IsNullOrWhiteSpace($extension)) {
                $extension = '.png'
            }
            $iconPath = Join-Path $env:TEMP ('steam_native_toasts_icon_' + [Math]::Abs($iconSource.GetHashCode()) + $extension)
            if (Test-Path -LiteralPath $iconPath) {
                $iconSource = [Uri]::new($iconPath).AbsoluteUri
            } else {
                try {
                    Invoke-WebRequest -Uri $iconSource -OutFile $iconPath -UseBasicParsing -TimeoutSec 8 -Headers @{ 'User-Agent' = 'Steam Native Toasts' } | Out-Null
                    if (Test-Path -LiteralPath $iconPath) {
                        $iconSource = [Uri]::new($iconPath).AbsoluteUri
                    }
                } catch {
                    # Keep original remote URL as a final fallback.
                }
            }
        } elseif (Test-Path -LiteralPath $iconSource) {
            $iconSource = [Uri]::new($iconSource).AbsoluteUri
        }

        if ($iconSource.Length -gt 0) {
            $safeIconSource = [System.Security.SecurityElement]::Escape($iconSource)
            $xml = $xml.Replace('%s', $safeIconSource)
        } else {
            $xml = [regex]::Replace($xml, '<image[^>]+src="' + [regex]::Escape('%s') + '"[^>]*/>', '')
        }
    }

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)

    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    $notifier = $null
    try {
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('%s')
    } catch {
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier()
    }
    $notifier.Show($toast)

    Set-Content -LiteralPath '%s' -Value 'success:toast'
    exit 0
} catch {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
        $notifyIcon.Visible = $true
        $notifyIcon.Text = '%s'
        $notifyIcon.BalloonTipTitle = '%s'
        $notifyIcon.BalloonTipText = '%s'
        $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::None
        $notifyIcon.ShowBalloonTip(5000)
        Start-Sleep -Milliseconds 6000
        $notifyIcon.Dispose()

        Set-Content -LiteralPath '%s' -Value ('success:fallback ' + $_.Exception.ToString())
        exit 0
    } catch {
        Set-Content -LiteralPath '%s' -Value ($_.Exception.ToString())
        exit 1
    }
} finally {
    Remove-Item -LiteralPath '%s' -ErrorAction SilentlyContinue
}
]]):format(
        escaped_steam_exe,
        TOAST_APP_ID:gsub("'", "''"),
        escaped_xml,
        escaped_icon_source,
        ICON_PLACEHOLDER,
        ICON_PLACEHOLDER,
        ICON_PLACEHOLDER,
        TOAST_APP_ID:gsub("'", "''"),
        escaped_log_path,
        TOAST_APP_ID:gsub("'", "''"),
        escaped_title,
        escaped_body,
        escaped_log_path,
        escaped_log_path,
        escaped_ps1_path
    )

    if not write_file(ps1_path, ps_script, true) then
        logger:error("Failed to write temporary PowerShell script")
        return false
    end

    local powershell_path = os.getenv("SystemRoot") or "C:\\Windows"
    powershell_path = powershell_path .. "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    local launched, result = run_hidden_process(
        powershell_path,
        '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' .. ps1_path:gsub('"', '""') .. '"'
    )
    local log_output = ""

    local log_file = io.open(log_path, "r")
    if log_file then
        log_output = log_file:read("*a") or ""
        log_file:close()
    end

    remove_file(log_path)

    if not launched or not os_execute_success(result) then
        if #log_output > 0 then
            logger:error("PowerShell notification command failed: " .. log_output:gsub("[%r\n]+", " "))
        elseif type(result) == "string" then
            logger:error("PowerShell notification command failed: " .. result)
        else
            logger:error("PowerShell notification command failed")
        end
        return false
    end

    if log_output:find("success:toast", 1, true) then
        logger:info("Native toast delivered")
        return true
    end

    if log_output:find("success:fallback", 1, true) then
        logger:info("Native fallback notification delivered")
        return true
    end

    if #log_output > 0 then
        logger:error("PowerShell notification command returned output: " .. log_output:gsub("[%r\n]+", " "))
    else
        logger:error("PowerShell notification command finished without success marker")
    end

    return false
end

function send_native_toast(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8)
    local payload = normalize_payload(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8)

    local ok, result = pcall(function()
        logger:info(
            "send_native_toast request title="
                .. summarize_log_text(payload.title or "", 80)
                .. " body="
                .. summarize_log_text(payload.body or "", 120)
                .. " trace="
                .. sanitize_text(payload.debugTraceId or "", 40)
                .. " source="
                .. sanitize_text(payload.debugSource or "", 60)
        )
        local xml = build_toast_xml(payload)
        return show_native_toast(xml, payload.title, payload.body, payload.icon)
    end)

    if not ok then
        logger:error("send_native_toast failed unexpectedly")
        return false
    end

    if result == true then
        return "success"
    end

    return "failure"
end

function write_trace_log(arg1)
    local message = ""
    if type(arg1) == "table" and type(arg1.message) == "string" then
        message = arg1.message
    elseif type(arg1) == "string" then
        message = arg1
    end

    if message == "" then
        return false
    end

    logger:info("TRACE " .. sanitize_trace_message_for_logging(message))
    return true
end

local function on_load()
    logger:info("Steam Native Toasts backend loaded")
    millennium.ready()
end

local function on_unload()
    logger:info("Steam Native Toasts backend unloaded")
end

local function on_frontend_loaded()
    logger:info("Steam Native Toasts frontend loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
    write_trace_log = write_trace_log
}
