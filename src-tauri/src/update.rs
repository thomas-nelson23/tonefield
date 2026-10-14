//! In-app updates from the repo's GitHub Releases. CI publishes a release for
//! every new version; this checks the latest one against the running version,
//! downloads the file built for how this copy was installed and installs it:
//! pacman or apt behind the system password prompt (pkexec), the AppImage
//! swapped in place, the Windows setup run in passive mode, the macOS disk
//! image opened for dragging into Applications.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Emitter};

const REPO: &str = "thomas-nelson23/tonefield";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const USER_AGENT: &str = concat!("Tonefield/", env!("CARGO_PKG_VERSION"));

/// How this copy was installed, which decides what gets downloaded and how.
#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pacman,
    Deb,
    Appimage,
    Windows,
    Macos,
    /// A dev build or something unrecognised: only the release page is offered.
    Manual,
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    available: bool,
    notes: String,
    page: String,
    kind: Kind,
    asset_url: Option<String>,
    asset_name: Option<String>,
}

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// "v0.2.10" → [0, 2, 10]. Anything after a '-' or '+' is ignored.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(latest), parse_version(current));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

fn succeeds(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn install_kind() -> Kind {
    if cfg!(debug_assertions) {
        return Kind::Manual;
    }
    if cfg!(target_os = "windows") {
        return Kind::Windows;
    }
    if cfg!(target_os = "macos") {
        return Kind::Macos;
    }
    if std::env::var_os("APPIMAGE").is_some() {
        Kind::Appimage
    } else if succeeds("pacman", &["-Qq", "tonefield"]) {
        Kind::Pacman
    } else if succeeds("dpkg-query", &["-W", "tonefield"]) {
        Kind::Deb
    } else {
        Kind::Manual
    }
}

/// The release file that fits this install, by the names CI gives them.
fn pick_asset(kind: Kind, assets: &[Asset]) -> Option<&Asset> {
    let arch = std::env::consts::ARCH; // "x86_64", "aarch64"
    let deb_arch = if arch == "x86_64" { "amd64" } else { arch };
    let fits = |a: &&Asset| match kind {
        Kind::Pacman => a.name.ends_with(&format!("-{arch}.pkg.tar.zst")),
        Kind::Deb => a.name.ends_with(&format!("_{deb_arch}.deb")),
        Kind::Appimage => a.name.ends_with(&format!("_{deb_arch}.AppImage")),
        Kind::Windows => a.name.ends_with("-setup.exe"),
        Kind::Macos => {
            let mac_arch = if arch == "x86_64" { "x64" } else { arch };
            a.name.ends_with(&format!("_{mac_arch}.dmg"))
        }
        Kind::Manual => false,
    };
    assets.iter().find(fits)
}

fn get(url: &str) -> Result<ureq::Response, String> {
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "No releases have been published yet.".to_string(),
            ureq::Error::Status(403, _) => {
                "GitHub is limiting update checks right now. Try again in an hour.".to_string()
            }
            ureq::Error::Status(code, _) => format!("GitHub answered with error {code}."),
            ureq::Error::Transport(t) => format!("Couldn't reach GitHub: {t}"),
        })
}

/// Look up the latest release. Runs off the main thread so the UI keeps going.
#[tauri::command(async)]
pub fn update_check() -> Result<UpdateInfo, String> {
    let body = get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let release: Release = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let kind = install_kind();
    let asset = pick_asset(kind, &release.assets);
    let latest = release.tag_name.trim_start_matches('v').to_string();
    Ok(UpdateInfo {
        available: newer(&latest, CURRENT),
        current: CURRENT.to_string(),
        latest,
        notes: release.body.unwrap_or_default(),
        page: release.html_url,
        // Without a file to fetch, all that's left is the release page
        kind: if asset.is_some() { kind } else { Kind::Manual },
        asset_url: asset.map(|a| a.browser_download_url.clone()),
        asset_name: asset.map(|a| a.name.clone()),
    })
}

fn download(app: &AppHandle, url: &str, name: &str) -> Result<PathBuf, String> {
    if name.contains(['/', '\\']) || !url.starts_with(&format!("https://github.com/{REPO}/")) {
        return Err("That isn't a Tonefield release file.".into());
    }
    let response = get(url)?;
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("tonefield-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut reader = response.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_sent = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_sent > 256 * 1024 {
            last_sent = done;
            let _ = app.emit("update-progress", Progress { done, total });
        }
    }
    let _ = app.emit("update-progress", Progress { done, total });
    Ok(path)
}

/// Run a command as root behind the desktop's password prompt.
#[cfg(target_os = "linux")]
fn as_root(args: &[&str]) -> Result<(), String> {
    let status = Command::new("pkexec").args(args).status().map_err(|_| {
        "pkexec isn't installed, so Tonefield can't ask for your password. \
         Install polkit, or run the install command yourself."
            .to_string()
    })?;
    match status.code() {
        Some(0) => Ok(()),
        // pkexec: 126 = the password prompt was dismissed, 127 = not authorised
        Some(126) | Some(127) => Err("The update was cancelled at the password prompt.".into()),
        _ => Err(format!("{} couldn't install the update.", args[0])),
    }
}

/// Download the update and install it. Returns once it's in place; on Windows
/// the installer takes over and the app quits so its files can be replaced.
#[tauri::command(async)]
pub fn update_install(app: AppHandle, kind: Kind, url: String, name: String) -> Result<(), String> {
    let path = download(&app, &url, &name)?;
    #[allow(unused_variables)]
    let file = path.to_string_lossy().to_string();
    match kind {
        #[cfg(target_os = "linux")]
        Kind::Pacman => as_root(&["pacman", "-U", "--noconfirm", &file]),
        #[cfg(target_os = "linux")]
        Kind::Deb => as_root(&["apt-get", "install", "-y", "--allow-downgrades", &file]),
        #[cfg(target_os = "linux")]
        Kind::Appimage => {
            use std::os::unix::fs::PermissionsExt;
            let target = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("Not running as an AppImage.")?);
            let staged = target.with_extension("new");
            std::fs::copy(&path, &staged).map_err(|e| format!("Couldn't write next to the AppImage: {e}"))?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            std::fs::rename(&staged, &target).map_err(|e| e.to_string())
        }
        #[cfg(target_os = "windows")]
        Kind::Windows => {
            // Passive: a progress window, no questions; /R starts Tonefield again after
            Command::new(&path)
                .args(["/P", "/R", "/UPDATE"])
                .spawn()
                .map_err(|e| format!("Couldn't start the installer: {e}"))?;
            app.exit(0);
            Ok(())
        }
        #[cfg(target_os = "macos")]
        Kind::Macos => Command::new("open")
            .arg(&path)
            .status()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        _ => Err("This copy of Tonefield can't update itself; download it from the release page.".into()),
    }
}

/// Start the freshly installed version and quit this one.
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<(), String> {
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| {
            // After pacman/apt replace the binary, /proc/self/exe points at the
            // deleted old file, so start the installed one by its path
            let installed = PathBuf::from("/usr/bin/tonefield");
            installed.exists().then_some(installed)
        })
        .or_else(|| std::env::current_exe().ok())
        .ok_or("Couldn't find Tonefield to restart it.")?;
    Command::new(exe).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// Open a release page in the default browser. Only this repo's pages.
#[tauri::command]
pub fn update_open_page(url: String) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{REPO}/")) {
        return Err("Not a Tonefield page.".into());
    }
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("0.2.0", "0.1.0"));
        assert!(newer("v0.10.0", "0.9.9"));
        assert!(newer("1.0", "0.9.9"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert!(!newer("0.2.0-beta", "0.2.0"));
    }

    #[test]
    fn picks_the_matching_file() {
        let assets: Vec<Asset> = [
            "Tonefield_0.2.0_amd64.deb",
            "Tonefield_0.2.0_amd64.AppImage",
            "Tonefield_0.2.0_x64-setup.exe",
            "Tonefield_0.2.0_aarch64.dmg",
            "tonefield-0.2.0-1-x86_64.pkg.tar.zst",
        ]
        .iter()
        .map(|n| Asset { name: n.to_string(), browser_download_url: String::new() })
        .collect();
        if std::env::consts::ARCH == "x86_64" {
            assert_eq!(pick_asset(Kind::Pacman, &assets).unwrap().name, "tonefield-0.2.0-1-x86_64.pkg.tar.zst");
            assert_eq!(pick_asset(Kind::Deb, &assets).unwrap().name, "Tonefield_0.2.0_amd64.deb");
            assert_eq!(pick_asset(Kind::Appimage, &assets).unwrap().name, "Tonefield_0.2.0_amd64.AppImage");
        }
        assert_eq!(pick_asset(Kind::Windows, &assets).unwrap().name, "Tonefield_0.2.0_x64-setup.exe");
        assert!(pick_asset(Kind::Manual, &assets).is_none());
    }
}
