use crate::{controller::PORT, DesktopResult};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::Ipv4Addr};
use tauri::Url;

pub const LOOPBACK_ENDPOINT: &str = "http://localhost:49372";
pub const LOOPBACK_BACKEND: &str = "http://127.0.0.1:49372";
pub const SERVE_PORT_ARGUMENT: &str = "--https=443";

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(tag = "mode", content = "endpoint", rename_all = "snake_case")]
pub enum NetworkMode {
    #[default]
    Local,
    Tailscale,
    Direct(String),
}

pub fn direct_endpoint(input: &str) -> DesktopResult<String> {
    let url = Url::parse(input.trim()).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.port() != Some(PORT)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .host_str()
            .is_some_and(|host| !host.starts_with('[') && host != "0.0.0.0")
    {
        return Err(format!(
            "Enter an HTTPS origin with a DNS name or IPv4 address and port {PORT}."
        ));
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct TailscaleStatus {
    backend_state: String,
    #[serde(rename = "Self")]
    node: Option<TailscaleNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleNode {
    #[serde(rename = "DNSName")]
    dns_name: String,
    online: bool,
}

impl TailscaleStatus {
    pub fn endpoint(self) -> DesktopResult<String> {
        let node = self
            .node
            .filter(|node| node.online && self.backend_state == "Running")
            .ok_or("Connect and sign in to Tailscale, then try again.")?;
        let name = node.dns_name.trim_end_matches('.').to_ascii_lowercase();
        if !name.ends_with(".ts.net")
            || name.len() > 253
            || name.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err("Tailscale did not provide a valid HTTPS hostname. Enable MagicDNS and HTTPS in Tailscale.".into());
        }
        Ok(format!("https://{name}"))
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ServeConfig {
    #[serde(rename = "TCP")]
    tcp: Option<HashMap<String, TcpHandler>>,
    web: Option<HashMap<String, WebServer>>,
    foreground: Option<HashMap<String, ServeConfig>>,
    allow_funnel: Option<HashMap<String, bool>>,
}

#[derive(Deserialize)]
struct TcpHandler {
    #[serde(rename = "HTTPS")]
    https: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WebServer {
    handlers: Option<HashMap<String, WebHandler>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WebHandler {
    proxy: Option<String>,
}

impl ServeConfig {
    pub fn uses_https_port(&self) -> bool {
        self.tcp.as_ref().is_some_and(|map| map.contains_key("443"))
            || self
                .web
                .as_ref()
                .is_some_and(|map| map.keys().any(|key| key.ends_with(":443")))
            || self.allow_funnel.as_ref().is_some_and(|map| {
                map.iter()
                    .any(|(key, value)| key.ends_with(":443") && *value)
            })
            || self
                .foreground
                .as_ref()
                .is_some_and(|sessions| sessions.values().any(Self::uses_https_port))
    }

    pub fn has_foreground_proxy(&self, endpoint: &str) -> bool {
        let Some(host) = endpoint.strip_prefix("https://") else {
            return false;
        };
        let host = format!("{host}:443");
        self.foreground.as_ref().is_some_and(|sessions| {
            sessions.values().any(|session| {
                session
                    .tcp
                    .as_ref()
                    .and_then(|map| map.get("443"))
                    .and_then(|handler| handler.https)
                    == Some(true)
                    && session
                        .web
                        .as_ref()
                        .and_then(|servers| servers.get(&host))
                        .and_then(|server| server.handlers.as_ref())
                        .and_then(|handlers| handlers.get("/"))
                        .and_then(|handler| handler.proxy.as_deref())
                        == Some(LOOPBACK_BACKEND)
                    && !session
                        .allow_funnel
                        .as_ref()
                        .is_some_and(|map| map.get(&host) == Some(&true))
            })
        })
    }
}

pub struct LaunchNetwork {
    pub endpoint: String,
    pub certificate: Option<Vec<u8>>,
    pub tailscale: bool,
}

impl LaunchNetwork {
    pub fn local() -> Self {
        Self {
            endpoint: LOOPBACK_ENDPOINT.into(),
            certificate: None,
            tailscale: false,
        }
    }

    pub fn listener(&self) -> String {
        if self.certificate.is_some() {
            "::".into()
        } else {
            Ipv4Addr::LOCALHOST.to_string()
        }
    }

    pub fn backend(&self) -> String {
        if self.certificate.is_some() {
            "https://127.0.0.1:49372".into()
        } else {
            LOOPBACK_BACKEND.into()
        }
    }
}
