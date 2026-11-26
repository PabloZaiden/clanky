use crate::{dialogs, Controller, DesktopResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

const STABLE: &str = "https://github.com/pablozaiden/clanky/releases/latest/download/clanky-linux-desktop-update.json";
const ROLLING: &str = "https://github.com/pablozaiden/clanky/releases/download/latest/clanky-linux-desktop-update.json";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Latest,
}

impl UpdateChannel {
    pub fn from_prerelease(prerelease: &str) -> Self {
        if prerelease.starts_with("main-") {
            Self::Latest
        } else {
            Self::Stable
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE,
            Self::Latest => ROLLING,
        }
    }
}

fn key() -> Option<&'static str> {
    option_env!("CLANKY_LINUX_UPDATE_PUBLIC_KEY").filter(|key| !key.trim().is_empty())
}

pub fn available(app: &AppHandle) -> bool {
    key().is_some() && app.env().appimage.is_some()
}

fn build_number(metadata: &str) -> Option<u32> {
    let number = metadata.strip_prefix("build.")?;
    if number.starts_with('0') || number.len() > 8 || !number.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

pub fn display_version(version: &str) -> &str {
    version.split_once('+').map_or(version, |(version, _)| version)
}

pub fn apply(
    app: &AppHandle,
    controller: &mut Controller,
    channel: UpdateChannel,
) -> DesktopResult<bool> {
    let key = key().ok_or("Updates are not configured for this build.")?;
    if app.env().appimage.is_none() {
        return Err("Open Clanky from its AppImage to install an update.".into());
    }
    let endpoint = Url::parse(channel.endpoint()).map_err(|error| error.to_string())?;
    let updater = app
        .updater_builder()
        .pubkey(key)
        .target(format!("linux-{}", std::env::consts::ARCH))
        .timeout(Duration::from_secs(60))
        .version_comparator(move |current, candidate| {
            // Tauri verifies the full version, including this sequence, against the signature.
            UpdateChannel::from_prerelease(candidate.version.pre.as_str()) == channel
                && matches!(
                    (build_number(current.build.as_str()), build_number(candidate.version.build.as_str())),
                    (Some(current), Some(candidate)) if candidate > current
                )
        })
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
    if !dialogs::confirm_update(app, display_version(&update.version))? {
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
