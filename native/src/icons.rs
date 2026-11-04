use std::path::{Path, PathBuf};

use windows::core::{IUnknown, GUID, HSTRING, PWSTR};
use windows::Win32::Graphics::GdiPlus::{
    GdipCreateBitmapFromHICON, GdipDisposeImage, GdipSaveImageToFile, GdiplusShutdown,
    GdiplusStartup, GdiplusStartupInput, GpBitmap, GpImage,
};
use windows::Win32::System::Com::IBindStatusCallback;
use windows::Win32::System::Com::Urlmon::URLDownloadToFileW;
use windows::Win32::UI::Shell::{ExtractIconExW, UrlCreateFromPathW};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

use crate::logging;

pub const ICON_PLACEHOLDER: &str = "__STEAM_NATIVE_TOAST_ICON__";
pub const STEAM_ICON_PLACEHOLDER: &str = "__STEAM_NATIVE_TOAST_STEAM_ICON__";

// PNG encoder CLSID from gdiplusimaging.h.
const PNG_ENCODER: GUID = GUID::from_u128(0x557cf406_1a04_11d3_9a73_0000f81ef32e);

pub fn data_dir() -> PathBuf {
    logging::data_dir()
}

pub fn cache_dir() -> PathBuf {
    data_dir().join("icons")
}

pub fn steam_icon_target() -> PathBuf {
    data_dir().join("steam.png")
}

pub fn resolve_placeholders(
    mut xml: String,
    icon: Option<&str>,
    steam_icon: Option<&str>,
) -> String {
    if xml.contains(ICON_PLACEHOLDER) {
        match icon.and_then(resolve_icon_source) {
            Some(path) => {
                let uri = path_to_uri(&path);
                xml = xml.replace(ICON_PLACEHOLDER, &escape_xml(&uri));
            }
            None => xml = remove_image_tag(&xml, ICON_PLACEHOLDER),
        }
    }

    if xml.contains(STEAM_ICON_PLACEHOLDER) {
        match steam_icon.map(PathBuf::from).filter(|path| is_usable(path)) {
            Some(path) => {
                let uri = path_to_uri(&path);
                xml = xml.replace(STEAM_ICON_PLACEHOLDER, &escape_xml(&uri));
            }
            None => xml = remove_image_tag(&xml, STEAM_ICON_PLACEHOLDER),
        }
    }

    materialize_inline_data_uris(xml)
}

/// Album art arrives as a data URI that is too large for the command line, so
/// the Lua backend embeds it directly in the toast XML. Convert it to a cached
/// file and swap in a file URI before handing the XML to WinRT.
fn materialize_inline_data_uris(mut xml: String) -> String {
    let mut search_from = 0usize;

    loop {
        let Some(relative) = xml[search_from..].find("src=\"data:image/") else {
            break;
        };
        let value_start = search_from + relative + "src=\"".len();
        let Some(value_end_relative) = xml[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + value_end_relative;
        let data_uri = xml[value_start..value_end].to_string();

        match materialize_data_uri(&data_uri) {
            Some(path) => {
                let replacement = escape_xml(&path_to_uri(&path));
                xml.replace_range(value_start..value_end, &replacement);
                search_from = value_start + replacement.len();
            }
            None => {
                let element_start = xml[..value_start].rfind("<image").unwrap_or(value_start);
                let element_end = xml[value_end..]
                    .find("/>")
                    .map(|offset| value_end + offset + 2)
                    .unwrap_or(value_end);
                xml.replace_range(element_start..element_end, "");
                search_from = element_start;
            }
        }
    }

    xml
}

fn resolve_icon_source(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("http://") || lowered.starts_with("https://") {
        return download_cached(trimmed);
    }
    if lowered.starts_with("data:image/") {
        return materialize_data_uri(trimmed);
    }
    if lowered.starts_with("file://") {
        let path = PathBuf::from(percent_decode(trimmed.trim_start_matches("file://")));
        return is_usable(&path).then_some(path);
    }

    let path = PathBuf::from(trimmed);
    is_usable(&path).then_some(path)
}

fn is_usable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn download_cached(url: &str) -> Option<PathBuf> {
    let cache = cache_dir();
    std::fs::create_dir_all(&cache).ok()?;

    let extension = extension_from_url(url);
    let name = format!("{:016x}{}", fnv1a64(url.as_bytes()), extension);
    let target = cache.join(name);
    if is_usable(&target) {
        return Some(target);
    }

    let partial = cache.join(format!("{:016x}.part", fnv1a64(url.as_bytes())));
    let _ = std::fs::remove_file(&partial);

    let partial_string = partial.to_string_lossy().into_owned();
    let result = unsafe {
        URLDownloadToFileW(
            None::<&IUnknown>,
            &HSTRING::from(url),
            &HSTRING::from(partial_string.as_str()),
            0,
            None::<&IBindStatusCallback>,
        )
    };

    if result.is_err() || !is_usable(&partial) {
        let _ = std::fs::remove_file(&partial);
        logging::error(&format!("icon download failed for {url}"));
        return None;
    }

    if std::fs::rename(&partial, &target).is_err() {
        let _ = std::fs::remove_file(&partial);
        return None;
    }

    prune_cache(&cache);
    Some(target)
}

fn extension_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" => format!(".{extension}"),
        _ => ".png".to_string(),
    }
}

fn materialize_data_uri(source: &str) -> Option<PathBuf> {
    let (metadata, payload) = source.split_once(',')?;
    if !metadata.to_ascii_lowercase().contains(";base64") {
        return None;
    }

    let bytes = decode_base64(payload)?;
    if bytes.is_empty() {
        return None;
    }

    let extension = if metadata.to_ascii_lowercase().contains("image/jpeg") {
        ".jpg"
    } else if metadata.to_ascii_lowercase().contains("image/gif") {
        ".gif"
    } else {
        ".png"
    };

    let cache = cache_dir();
    std::fs::create_dir_all(&cache).ok()?;
    let path = cache.join(format!("{:016x}{extension}", fnv1a64(&bytes)));
    if is_usable(&path) {
        return Some(path);
    }

    std::fs::write(&path, &bytes).ok()?;
    Some(path)
}

fn prune_cache(cache: &Path) {
    const MAX_FILES: usize = 200;
    let Ok(entries) = std::fs::read_dir(cache) else {
        return;
    };

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((metadata.modified().ok()?, path))
        })
        .collect();

    if files.len() <= MAX_FILES {
        return;
    }

    files.sort_by_key(|(modified, _)| *modified);
    let remove_count = files.len() - MAX_FILES;
    for (_, path) in files.into_iter().take(remove_count) {
        let _ = std::fs::remove_file(path);
    }
}

fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy();
    let wide = HSTRING::from(text.as_ref());

    unsafe {
        let mut buffer = vec![0u16; 4096];
        let mut length = buffer.len() as u32;
        if UrlCreateFromPathW(&wide, PWSTR(buffer.as_mut_ptr()), &mut length, 0).is_ok() {
            let end = (length as usize).min(buffer.len());
            let uri = String::from_utf16_lossy(&buffer[..end]);
            let uri = uri.trim_end_matches('\0');
            if !uri.is_empty() {
                return uri.to_string();
            }
        }
    }

    let normalized = text.replace('\\', "/");
    format!("file:///{}", percent_encode(&normalized))
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn remove_image_tag(xml: &str, placeholder: &str) -> String {
    let mut result = xml.to_string();
    while let Some(position) = result.find(placeholder) {
        let prefix = &result[..position];
        let start = prefix.rfind("<image").unwrap_or(position);
        let end = result[position..]
            .find("/>")
            .map(|offset| position + offset + 2)
            .unwrap_or(position + placeholder.len());
        result.replace_range(start..end, "");
    }
    result
}

fn fnv1a64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };

        buffer = (buffer << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }

    Some(output)
}

pub fn extract_icon(executable: &Path, target: &Path) -> windows::core::Result<()> {
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    unsafe {
        let mut large = HICON::default();
        let extracted = ExtractIconExW(
            &HSTRING::from(executable.to_string_lossy().as_ref()),
            0,
            Some(&mut large),
            None,
            1,
        );

        if extracted == 0 || large.is_invalid() {
            return Err(windows::core::Error::from_thread());
        }

        let mut token = 0usize;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        let mut startup_output = Default::default();
        let startup = GdiplusStartup(&mut token, &input, &mut startup_output);
        if startup.0 != 0 {
            let _ = DestroyIcon(large);
            return Err(windows::core::Error::from_thread());
        }

        let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
        let created = GdipCreateBitmapFromHICON(large, &mut bitmap);
        if created.0 != 0 || bitmap.is_null() {
            GdiplusShutdown(token);
            let _ = DestroyIcon(large);
            return Err(windows::core::Error::from_thread());
        }

        let saved = GdipSaveImageToFile(
            bitmap as *mut GpImage,
            &HSTRING::from(target.to_string_lossy().as_ref()),
            &PNG_ENCODER,
            std::ptr::null(),
        );

        GdipDisposeImage(bitmap as *mut GpImage);
        GdiplusShutdown(token);
        let _ = DestroyIcon(large);

        if saved.0 != 0 {
            return Err(windows::core::Error::from_thread());
        }
    }

    Ok(())
}
