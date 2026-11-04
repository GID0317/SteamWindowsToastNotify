use std::path::{Path, PathBuf};

use windows::core::{Interface, Result, GUID, HSTRING, PWSTR};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::IShellLinkW;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

const SHELL_LINK_CLSID: GUID = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);

pub fn ensure(
    app_id: &str,
    target: &Path,
    name: &str,
    shortcut_override: Option<&Path>,
) -> Result<PathBuf> {
    let shortcut = shortcut_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_shortcut_path(app_id));

    if let Some(programs) = shortcut.parent() {
        remove_legacy_shortcuts(programs);
    }

    // Steam already ships this shortcut with the right AUMID. Only create it
    // when it is missing, so user customizations are left untouched.
    if shortcut_override.is_none() && shortcut.exists() {
        return Ok(shortcut);
    }

    let target_string = target.to_string_lossy().into_owned();
    let shortcut_string = shortcut.to_string_lossy().into_owned();

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;

        let link: IShellLinkW = CoCreateInstance(&SHELL_LINK_CLSID, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target_string.as_str()))?;
        link.SetArguments(&HSTRING::from(""))?;
        link.SetDescription(&HSTRING::from(name))?;
        link.SetIconLocation(&HSTRING::from(target_string.as_str()), 0)?;

        let store: IPropertyStore = link.cast()?;
        let mut inner = PROPVARIANT_0_0 {
            vt: VT_LPWSTR,
            ..Default::default()
        };

        let mut wide: Vec<u16> = app_id.encode_utf16().collect();
        wide.push(0);
        let memory = CoTaskMemAlloc(wide.len() * std::mem::size_of::<u16>()) as *mut u16;
        if memory.is_null() {
            return Err(windows::core::Error::from_thread());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), memory, wide.len());
        inner.Anonymous.pwszVal = PWSTR(memory);

        let value = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(inner),
            },
        };

        store.SetValue(&PKEY_AppUserModel_ID, &value)?;
        store.Commit()?;

        let persist: IPersistFile = link.cast()?;
        persist.Save(&HSTRING::from(shortcut_string.as_str()), true)?;

        // The shell property store may keep VT_LPWSTR storage alive until the
        // store is released. This helper is one-shot, so leave the
        // CoTaskMemAlloc allocation to the OS instead of risking a
        // use-after-free during shutdown.
    }

    Ok(shortcut)
}

fn default_shortcut_path(app_id: &str) -> PathBuf {
    let programs = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");

    let file_name = if app_id.eq_ignore_ascii_case("Steam") {
        "Steam.lnk".to_string()
    } else {
        format!("{app_id}.lnk")
    };

    programs.join(file_name)
}

fn remove_legacy_shortcuts(programs: &Path) {
    for name in ["Steam Toast Bridge.lnk", "Steam Native Toasts.lnk"] {
        let path = programs.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
}
