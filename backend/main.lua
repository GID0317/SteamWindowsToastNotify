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
local STEAM_ICON_PLACEHOLDER = "__STEAM_NATIVE_TOAST_STEAM_ICON__"
local DEBUG_MODE = os.getenv("STEAM_NATIVE_TOASTS_DEBUG") == "1"

ffi.cdef[[
typedef void* HANDLE;
typedef void* LPVOID;
typedef const wchar_t* LPCWSTR;
typedef wchar_t* LPWSTR;
typedef unsigned long DWORD;
typedef int BOOL;
typedef unsigned short WORD;
typedef unsigned int UINT;

typedef struct {
    DWORD nLength;
    LPVOID lpSecurityDescriptor;
    BOOL bInheritHandle;
} SECURITY_ATTRIBUTES;

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
BOOL __stdcall CreatePipe(HANDLE* hReadPipe, HANDLE* hWritePipe, SECURITY_ATTRIBUTES* lpPipeAttributes, DWORD nSize);
BOOL __stdcall SetHandleInformation(HANDLE hObject, DWORD dwMask, DWORD dwFlags);
BOOL __stdcall WriteFile(HANDLE hFile, const void* lpBuffer, DWORD nNumberOfBytesToWrite, DWORD* lpNumberOfBytesWritten, LPVOID lpOverlapped);
HANDLE __stdcall CreateFileW(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode, SECURITY_ATTRIBUTES* lpSecurityAttributes, DWORD dwCreationDisposition, DWORD dwFlagsAndAttributes, HANDLE hTemplateFile);
int __stdcall MultiByteToWideChar(UINT CodePage, DWORD dwFlags, const char* lpMultiByteStr, int cbMultiByte, LPWSTR lpWideCharStr, int cchWideChar);
]]

local kernel32 = ffi.load("kernel32")

local CREATE_NO_WINDOW = 0x08000000
local STARTF_USESTDHANDLES = 0x00000100
local HANDLE_FLAG_INHERIT = 0x00000001
local GENERIC_WRITE = 0x40000000
local FILE_SHARE_READ_WRITE = 0x00000003
local OPEN_EXISTING = 3
local FILE_ATTRIBUTE_NORMAL = 0x80
local CP_UTF8 = 65001
local MAX_COMMAND_LINE_LENGTH = 32767
local INVALID_HANDLE_VALUE = ffi.cast("HANDLE", -1)

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

local function utf8_safe_truncate(value, max_bytes)
    if max_bytes <= 0 then
        return ""
    end
    if #value <= max_bytes then
        return value
    end

    local cut = max_bytes
    while cut > 0 do
        local next_byte = value:byte(cut + 1)
        if not next_byte or next_byte < 0x80 or next_byte >= 0xC0 then
            break
        end
        cut = cut - 1
    end
    return value:sub(1, cut)
end

local function strip_control_chars(value)
    return (value:gsub("[%z\1-\31\127]", ""))
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

    -- Keep tabs and newlines; drop every other control byte that XML rejects.
    local sanitized = value:gsub("[%z\1-\8\11\12\13\14-\31\127]", " ")
    return utf8_safe_truncate(sanitized, max_length)
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

local function script_directories()
    -- Calling debug.getinfo through pcall would inspect pcall itself (a C
    -- function), so call it directly; a valid level never raises.
    local info = debug.getinfo(1, "S")
    local source = info and info.source or nil
    if type(source) ~= "string" or source:sub(1, 1) ~= "@" then
        return nil, nil
    end

    local backend_dir = parent_directory(source:sub(2))
    local plugin_dir = parent_directory(backend_dir)
    return backend_dir, plugin_dir
end

local function add_steam_exe_candidate(candidates, path, source)
    local normalized = normalize_windows_path(path)
    if normalized and file_exists(normalized) then
        table.insert(candidates, { path = normalized, source = source })
    end
end

local function add_steam_dir_candidate(candidates, dir, source)
    add_steam_exe_candidate(candidates, join_windows_path(dir, "Steam.exe"), source)
end

local cached_steam_exe
local steam_lookup_done = false

-- Resolve Steam once per session. The path never changes while Steam is running,
-- and looking it up on every toast only adds disk I/O to the send path.
local function resolve_steam_exe_path()
    if cached_steam_exe then
        return cached_steam_exe
    end
    if steam_lookup_done then
        return nil
    end
    steam_lookup_done = true

    local candidates = {}

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

    local backend_dir, plugin_dir = script_directories()
    if backend_dir and plugin_dir then
        local plugins_dir = parent_directory(plugin_dir)
        local millennium_dir = parent_directory(plugins_dir)
        local steam_dir = parent_directory(millennium_dir)
        add_steam_dir_candidate(candidates, steam_dir, "plugin_path")
    end

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
        cached_steam_exe = selected.path
        return cached_steam_exe
    end

    logger:info("resolved_steam_exe source=none")
    return nil
end

local cached_helper_path
local helper_lookup_done = false

local function resolve_helper_path()
    if helper_lookup_done then
        return cached_helper_path
    end
    helper_lookup_done = true

    local backend_dir, plugin_dir = script_directories()
    local candidates = {}

    if backend_dir then
        table.insert(candidates, backend_dir .. "\\bin\\toast-helper.exe")
    end
    if plugin_dir then
        table.insert(candidates, plugin_dir .. "\\backend\\bin\\toast-helper.exe")
        table.insert(candidates, plugin_dir .. "\\bin\\toast-helper.exe")
    end

    for _, candidate in ipairs(candidates) do
        if file_exists(candidate) then
            cached_helper_path = candidate
            logger:info("toast helper resolved path=" .. summarize_log_text(candidate, 160))
            return cached_helper_path
        end
    end

    logger:warn("toast helper not found; PowerShell fallback will be used")
    return nil
end

local cached_fallback_script
local fallback_lookup_done = false

local function resolve_fallback_script()
    if fallback_lookup_done then
        return cached_fallback_script
    end
    fallback_lookup_done = true

    local backend_dir = script_directories()
    if not backend_dir then
        return nil
    end

    local path = backend_dir .. "\\bin\\toast-fallback.ps1"
    if file_exists(path) then
        cached_fallback_script = path
        return cached_fallback_script
    end

    return nil
end

local function sanitize_protocol_url(url)
    if type(url) ~= "string" then
        return nil
    end

    local normalized = strip_control_chars(url):match("^%s*(.-)%s*$")
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

    local normalized = strip_control_chars(icon):match("^%s*(.-)%s*$")
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
    local length = #text
    if length == 0 then
        return ffi.new("wchar_t[1]", 0)
    end

    local needed = kernel32.MultiByteToWideChar(CP_UTF8, 0, text, length, nil, 0)
    if needed <= 0 then
        return nil
    end

    local buffer = ffi.new("wchar_t[?]", needed + 1)
    kernel32.MultiByteToWideChar(CP_UTF8, 0, text, length, buffer, needed)
    buffer[needed] = 0
    return buffer
end

local function quote_arg(value)
    local text = tostring(value or "")
    if text == "" then
        return '""'
    end
    if not text:find('[%s"]') then
        return text
    end

    local output = { '"' }
    local backslashes = 0

    for index = 1, #text do
        local char = text:sub(index, index)
        if char == "\\" then
            backslashes = backslashes + 1
        elseif char == '"' then
            table.insert(output, string.rep("\\", backslashes * 2 + 1))
            table.insert(output, '"')
            backslashes = 0
        else
            if backslashes > 0 then
                table.insert(output, string.rep("\\", backslashes))
                backslashes = 0
            end
            table.insert(output, char)
        end
    end

    if backslashes > 0 then
        table.insert(output, string.rep("\\", backslashes * 2))
    end
    table.insert(output, '"')
    return table.concat(output)
end

local function join_arguments(arguments)
    local parts = {}
    for _, argument in ipairs(arguments) do
        table.insert(parts, quote_arg(argument))
    end
    return table.concat(parts, " ")
end

-- Spawn a process without a console window.
-- stdin_data is written through an anonymous pipe and the pipe is closed, so the
-- child sees EOF. wait_ms = 0 means fire-and-forget.
local function run_process(executable, arguments, stdin_data, wait_ms)
    local executable_wide = to_wide(executable)
    if not executable_wide then
        return false, "utf8 conversion failed"
    end

    local command_line = '"' .. executable .. '"'
    if arguments and #arguments > 0 then
        command_line = command_line .. " " .. arguments
    end
    if #command_line > MAX_COMMAND_LINE_LENGTH then
        return false, "command line too long"
    end

    local command_line_wide = to_wide(command_line)
    if not command_line_wide then
        return false, "utf8 conversion failed"
    end

    local startup_info = ffi.new("STARTUPINFOW")
    startup_info.cb = ffi.sizeof(startup_info)

    local read_end
    local write_end
    local nul_handle
    local inherit_handles = 0

    if stdin_data then
        local attributes = ffi.new("SECURITY_ATTRIBUTES")
        attributes.nLength = ffi.sizeof(attributes)
        attributes.lpSecurityDescriptor = nil
        attributes.bInheritHandle = 1

        local read_pointer = ffi.new("HANDLE[1]")
        local write_pointer = ffi.new("HANDLE[1]")
        if kernel32.CreatePipe(read_pointer, write_pointer, attributes, 262144) == 0 then
            return false, "CreatePipe failed: " .. tostring(tonumber(kernel32.GetLastError()))
        end

        read_end = read_pointer[0]
        write_end = write_pointer[0]
        kernel32.SetHandleInformation(write_end, HANDLE_FLAG_INHERIT, 0)
        inherit_handles = 1

        local nul_attributes = ffi.new("SECURITY_ATTRIBUTES")
        nul_attributes.nLength = ffi.sizeof(nul_attributes)
        nul_attributes.lpSecurityDescriptor = nil
        nul_attributes.bInheritHandle = 1

        local nul_name = to_wide("\\\\.\\NUL")
        nul_handle = kernel32.CreateFileW(
            nul_name,
            GENERIC_WRITE,
            FILE_SHARE_READ_WRITE,
            nul_attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nil
        )
        if nul_handle == INVALID_HANDLE_VALUE then
            nul_handle = nil
        end

        startup_info.dwFlags = STARTF_USESTDHANDLES
        startup_info.hStdInput = read_end
        startup_info.hStdOutput = nul_handle
        startup_info.hStdError = nul_handle
    end

    local process_info = ffi.new("PROCESS_INFORMATION")
    local created = kernel32.CreateProcessW(
        executable_wide,
        command_line_wide,
        nil,
        nil,
        inherit_handles,
        CREATE_NO_WINDOW,
        nil,
        nil,
        startup_info,
        process_info
    )

    if created == 0 then
        local error_code = tonumber(kernel32.GetLastError())
        if read_end then
            kernel32.CloseHandle(read_end)
        end
        if write_end then
            kernel32.CloseHandle(write_end)
        end
        if nul_handle then
            kernel32.CloseHandle(nul_handle)
        end
        return false, "CreateProcessW failed: " .. tostring(error_code)
    end

    if read_end then
        kernel32.CloseHandle(read_end)
    end

    if stdin_data and write_end then
        local written = ffi.new("DWORD[1]", 0)
        kernel32.WriteFile(write_end, ffi.cast("const char*", stdin_data), #stdin_data, written, nil)
        kernel32.CloseHandle(write_end)
    end

    local exit_code
    if wait_ms and wait_ms > 0 then
        local wait_result = kernel32.WaitForSingleObject(process_info.hProcess, wait_ms)
        if wait_result == 0 then
            local code = ffi.new("DWORD[1]", 0)
            if kernel32.GetExitCodeProcess(process_info.hProcess, code) ~= 0 then
                exit_code = tonumber(code[0])
            end
        else
            exit_code = -1
        end
    end

    kernel32.CloseHandle(process_info.hThread)
    kernel32.CloseHandle(process_info.hProcess)
    if nul_handle then
        kernel32.CloseHandle(nul_handle)
    end

    return true, exit_code
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

local function payload_from_fields(fields)
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

local function normalize_payload(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8)
    if type(arg1) == "table" and type(arg1.payload_blob) == "string" then
        return payload_from_fields(split_blob(arg1.payload_blob))
    end

    if type(arg1) == "string" and arg2 == nil and arg1:find(FIELD_SEPARATOR, 1, true) then
        return payload_from_fields(split_blob(arg1))
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

    table.insert(xml, "<toast" .. launch_attr .. scenario_attr .. ">")
    table.insert(xml, "<visual>")
    table.insert(xml, '<binding template="ToastGeneric">')

    if icon or type_name == "General" or type_name == "DownloadComplete" then
        local icon_source
        if icon then
            -- Data URIs can be hundreds of kilobytes, so embed them in the XML
            -- instead of passing them on the command line.
            if icon:lower():match("^data:image/") then
                icon_source = icon
            else
                icon_source = ICON_PLACEHOLDER
            end
        else
            icon_source = STEAM_ICON_PLACEHOLDER
        end
        table.insert(xml, '<image placement="appLogoOverride" hint-crop="circle" src="' .. xml_escape(icon_source) .. '"/>')
    end

    if title ~= "" then
        table.insert(xml, "<text>" .. xml_escape(title) .. "</text>")
    end
    if body ~= "" then
        table.insert(xml, "<text>" .. xml_escape(body) .. "</text>")
    end
    table.insert(xml, "</binding>")
    table.insert(xml, "</visual>")

    if #actions > 0 then
        table.insert(xml, "<actions>")
        for _, action in ipairs(actions) do
            table.insert(
                xml,
                '<action content="'
                    .. xml_escape(action.label)
                    .. '" activationType="protocol" arguments="'
                    .. xml_escape(action.url)
                    .. '"/>'
            )
        end
        if is_incoming_voice then
            table.insert(xml, '<action content="Dismiss" activationType="system" arguments="dismiss"/>')
        elseif is_friend_in_game then
            table.insert(xml, '<action content="Ignore" activationType="system" arguments="dismiss"/>')
        end
        table.insert(xml, "</actions>")
    end

    if not play_sound then
        table.insert(xml, '<audio silent="true"/>')
    end

    table.insert(xml, "</toast>")
    return table.concat(xml)
end

local function steam_icon_path()
    local base = os.getenv("LOCALAPPDATA") or os.getenv("TEMP") or "."
    return base .. "\\SteamWindowsToastNotification\\steam.png"
end

local function remove_image_element_containing(xml, needle)
    local result = xml
    while true do
        local position = result:find(needle, 1, true)
        if not position then
            break
        end

        local start_position
        local search_index = 1
        while true do
            local candidate = result:find("<image", search_index, true)
            if not candidate or candidate > position then
                break
            end
            start_position = candidate
            search_index = candidate + 1
        end

        local end_position = result:find("/>", position, true)
        if not start_position or not end_position then
            break
        end

        result = result:sub(1, start_position - 1) .. result:sub(end_position + 2)
    end

    return result
end

local function show_fallback_toast(xml)
    local fallback_script = resolve_fallback_script()
    if not fallback_script then
        logger:error("No toast backend available: helper and fallback script are missing")
        return false
    end

    local sanitized_xml = remove_image_element_containing(xml, ICON_PLACEHOLDER)
    sanitized_xml = remove_image_element_containing(sanitized_xml, STEAM_ICON_PLACEHOLDER)
    sanitized_xml = remove_image_element_containing(sanitized_xml, 'src="data:image/')

    local temp_dir = os.getenv("TEMP") or os.getenv("TMP") or "."
    local suffix = tostring(os.time()) .. "_" .. tostring(math.random(100000, 999999))
    local xml_path = temp_dir .. "\\steam_native_toast_" .. suffix .. ".xml"
    local log_path = temp_dir .. "\\steam_native_toast_fallback.log"

    if not write_file(xml_path, sanitized_xml, false) then
        logger:error("Failed to write fallback toast payload")
        return false
    end

    local powershell = (os.getenv("SystemRoot") or "C:\\Windows")
        .. "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    local arguments = join_arguments({
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fallback_script,
        "-XmlPath",
        xml_path,
        "-AppId",
        TOAST_APP_ID,
        "-LogPath",
        log_path
    })

    local ok, detail = run_process(powershell, arguments, nil, 0)
    if not ok then
        remove_file(xml_path)
        logger:error("PowerShell fallback spawn failed: " .. tostring(detail))
        return false
    end

    logger:warn("toast queued via PowerShell fallback")
    return true
end

local function show_native_toast(xml, title, body, icon_source)
    logger:info(
        "show_native_toast begin title="
            .. summarize_log_text(title or "", 80)
            .. " body="
            .. summarize_log_text(body or "", 120)
    )

    local helper = resolve_helper_path()
    if helper then
        local arguments = { "show", "--app-id", TOAST_APP_ID }

        local safe_icon = sanitize_icon_source(icon_source)
        if DEBUG_MODE then
            local icon_kind = "none"
            if safe_icon then
                local lowered = safe_icon:lower()
                if lowered:match("^data:image/") then
                    icon_kind = "data"
                elseif lowered:match("^https?://") then
                    icon_kind = "remote"
                else
                    icon_kind = "file"
                end
            end
            logger:info("toast icon kind=" .. icon_kind)
        end
        if safe_icon and not safe_icon:lower():match("^data:image/") then
            table.insert(arguments, "--icon")
            table.insert(arguments, safe_icon)
        end

        local steam_icon = steam_icon_path()
        if file_exists(steam_icon) then
            table.insert(arguments, "--steam-icon")
            table.insert(arguments, steam_icon)
        end

        local ok, detail = run_process(helper, join_arguments(arguments), xml, 0)
        if ok then
            logger:info("toast queued via native helper")
            return true
        end

        logger:error("native helper spawn failed: " .. tostring(detail))
    end

    return show_fallback_toast(xml)
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
        logger:error("send_native_toast failed unexpectedly: " .. sanitize_text(tostring(result), 200))
        return "failure"
    end

    return result and "queued" or "failure"
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

local function read_identity()
    local base = os.getenv("LOCALAPPDATA") or os.getenv("TEMP") or "."
    local file = io.open(base .. "\\SteamWindowsToastNotification\\identity.txt", "rb")
    if not file then
        return nil
    end

    local content = file:read("*a")
    file:close()
    return content
end

local function register_toast_identity()
    local helper = resolve_helper_path()
    if not helper then
        return
    end

    local steam_exe = resolve_steam_exe_path()
    if not steam_exe then
        logger:warn("Steam executable not found; toast identity registration skipped")
        return
    end

    local appdata = os.getenv("APPDATA")
    local steam_shortcut = appdata
        and (appdata .. "\\Microsoft\\Windows\\Start Menu\\Programs\\Steam.lnk")
        or nil
    local legacy_shortcut_a = appdata
        and (appdata .. "\\Microsoft\\Windows\\Start Menu\\Programs\\Steam Toast Bridge.lnk")
        or nil
    local legacy_shortcut_b = appdata
        and (appdata .. "\\Microsoft\\Windows\\Start Menu\\Programs\\Steam Native Toasts.lnk")
        or nil

    local expected_identity = steam_shortcut
        and (TOAST_APP_ID .. "\n" .. steam_exe .. "\n" .. steam_shortcut)
        or nil

    if
        expected_identity
        and read_identity() == expected_identity
        and file_exists(steam_icon_path())
        and not file_exists(legacy_shortcut_a)
        and not file_exists(legacy_shortcut_b)
    then
        logger:info("toast identity already registered")
        return
    end

    local arguments = join_arguments({
        "register",
        "--app-id",
        TOAST_APP_ID,
        "--target",
        steam_exe,
        "--name",
        "Steam"
    })

    -- Fire-and-forget: registration is a safety net (Steam normally ships its
    -- own shortcut) and must not block Steam's startup for an antivirus scan.
    local ok, detail = run_process(helper, arguments, nil, 0)
    logger:info("toast_identity register queued=" .. tostring(ok) .. " detail=" .. tostring(detail))
end

local function on_load()
    logger:info("SteamWindowsToastNotification backend loaded")
    register_toast_identity()
    millennium.ready()
end

local function on_unload()
    logger:info("SteamWindowsToastNotification backend unloaded")
end

local function on_frontend_loaded()
    logger:info("SteamWindowsToastNotification frontend loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
    write_trace_log = write_trace_log,
    send_native_toast = send_native_toast
}
