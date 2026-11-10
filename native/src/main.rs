#![windows_subsystem = "windows"]

mod icons;
mod logging;
mod shortcut;
mod toast;

use std::io::Read;
use std::path::PathBuf;

fn main() {
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("show");

    match command {
        "show" => cmd_show(&args),
        "register" => cmd_register(&args),
        "version" | "--version" | "-v" => {
            let version = env!("CARGO_PKG_VERSION");
            logging::info(&format!("version {version}"));
            0
        }
        other => {
            logging::error(&format!("unknown command: {other}"));
            2
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn cmd_show(args: &[String]) -> i32 {
    // A stuck network download must never leave a helper running forever.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(20));
        std::process::exit(0);
    });

    let app_id = flag(args, "--app-id").unwrap_or("Steam");
    let icon = flag(args, "--icon");
    let steam_icon = flag(args, "--steam-icon");
    let tag = flag(args, "--tag");
    let group = flag(args, "--group");

    let mut raw = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut raw) {
        logging::error(&format!("failed to read stdin: {error}"));
        return 3;
    }
    let xml = String::from_utf8_lossy(&raw).into_owned();
    if xml.trim().is_empty() {
        logging::error("empty toast payload");
        return 3;
    }

    let xml = icons::resolve_placeholders(xml, icon, steam_icon);

    match toast::show(&xml, app_id, tag, group) {
        Ok(()) => {
            logging::info(&format!("toast shown app_id={app_id}"));
            0
        }
        Err(error) => {
            logging::error(&format!("toast failed: {error}"));
            1
        }
    }
}

fn cmd_register(args: &[String]) -> i32 {
    let app_id = flag(args, "--app-id").unwrap_or("Steam");
    let name = flag(args, "--name").unwrap_or("Steam");
    let target = match flag(args, "--target") {
        Some(value) => PathBuf::from(value),
        None => {
            logging::error("register requires --target");
            return 2;
        }
    };
    let shortcut_override = flag(args, "--shortcut").map(PathBuf::from);

    if !target.exists() {
        logging::error(&format!(
            "register target does not exist: {}",
            target.display()
        ));
        return 4;
    }

    match shortcut::ensure(app_id, &target, name, shortcut_override.as_deref()) {
        Ok(path) => {
            let icon_target = icons::steam_icon_target();
            if let Err(error) = icons::extract_icon(&target, &icon_target) {
                logging::error(&format!("icon extraction failed: {error}"));
            }

            let identity = format!("{}\n{}\n{}", app_id, target.display(), path.display());
            let _ = std::fs::write(icons::data_dir().join("identity.txt"), identity);

            logging::info(&format!("registered {}", path.display()));
            0
        }
        Err(error) => {
            logging::error(&format!("register failed: {error}"));
            1
        }
    }
}
