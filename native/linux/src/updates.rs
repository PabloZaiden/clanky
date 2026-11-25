use crate::{dialogs, Controller, DesktopResult};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

const STABLE: &str = "https://github.com/pablozaiden/clanky/releases/latest/download/clanky-linux-desktop-update.json";
const ROLLING: &str = "https://github.com/pablozaiden/clanky/releases/download/latest/clanky-linux-desktop-update.json";

pub fn apply(app: &AppHandle, controller: &mut Controller) -> DesktopResult<bool> {
    let key = option_env!("CLANKY_LINUX_UPDATE_PUBLIC_KEY")
        .filter(|key| !key.trim().is_empty())
        .ok_or("Updates are not configured for this build.")?;
    if app.env().appimage.is_none() {
        return Err("Open Clanky from its AppImage to install an update.".into());
    }
    let endpoint = if app.package_info().version.pre.starts_with("main-") {
        ROLLING
    } else {
        STABLE
    };
    let endpoint = Url::parse(endpoint).map_err(|error| error.to_string())?;
    let updater = app
        .updater_builder()
        .pubkey(key)
        .target(format!("linux-{}", std::env::consts::ARCH))
        .timeout(Duration::from_secs(60))
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| format!("Cannot configure Clanky updates: {error}"))?;

    let update = tauri::async_runtime::block_on(updater.check())
        .map_err(|error| format!("Cannot check for updates: {error}"))?;
    let Some(update) = update else {
        dialogs::notice(app, "Clanky is up to date.")?;
        return Ok(false);
    };
    if update.download_url.scheme() != "https" {
        return Err("The update must be downloaded over HTTPS.".into());
    }
    if !dialogs::confirm_update(app, &update.version)? {
        return Ok(false);
    }
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
        .map_err(|error| format!("Cannot download and verify the Clanky update: {error}"))?;
    controller.stop()?;
    update
        .install(bytes)
        .map_err(|error| format!("Cannot replace the Clanky AppImage: {error}"))?;
    Ok(true)
}
