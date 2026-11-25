use crate::{DesktopResult, SharedEndpoint};
use percent_encoding::percent_decode_str;
use serde_json::Value;
use socket2::{Domain, Socket, Type};
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
};
use tauri::{AppHandle, Url};
use tiny_http::{Header, Method, Request, Response, Server};

pub fn bind(port: u16) -> DesktopResult<TcpListener> {
    let bind = || -> std::io::Result<TcpListener> {
        let socket = Socket::new(Domain::IPV4, Type::STREAM, None)?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into())?;
        socket.listen(128)?;
        Ok(socket.into())
    };
    bind()
        .map_err(|error| format!("Cannot open the local Clanky interface on port {port}: {error}"))
}
pub fn serve(
    app: AppHandle,
    listener: TcpListener,
    endpoint: SharedEndpoint,
) -> DesktopResult<Url> {
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let origin = Url::parse(&format!("http://{address}/")).map_err(|error| error.to_string())?;
    let server = Server::from_listener(listener, None).map_err(|error| error.to_string())?;
    let paths = app
        .asset_resolver()
        .iter()
        .map(|(path, _)| path.trim_start_matches('/').to_owned())
        .collect();
    std::thread::Builder::new()
        .name("clanky-assets".into())
        .spawn(move || {
            let host = address.to_string();
            for request in server.incoming_requests() {
                if let Err(error) = respond(request, &app, &host, &endpoint, &paths) {
                    if error.kind() != std::io::ErrorKind::BrokenPipe {
                        eprintln!("Clanky UI response failed: {error}");
                    }
                }
            }
        })
        .map_err(|error| format!("Cannot start the local Clanky interface: {error}"))?;
    Ok(origin)
}

fn asset_path(target: &str) -> Option<String> {
    let path = percent_decode_str(target.split('?').next()?)
        .decode_utf8()
        .ok()?;
    let relative = path.strip_prefix('/')?;
    if relative.starts_with('/')
        || relative.contains(['\\', '\0', '%'])
        || relative.split('/').any(|part| matches!(part, "." | ".."))
    {
        return None;
    }
    if relative.is_empty() || relative.ends_with('/') {
        Some(format!("{relative}index.html"))
    } else {
        Some(relative.to_owned())
    }
}

fn respond(
    request: Request,
    app: &AppHandle,
    host: &str,
    endpoint: &SharedEndpoint,
    paths: &HashSet<String>,
) -> std::io::Result<()> {
    if !matches!(request.method(), Method::Get | Method::Head) {
        return request.respond(Response::empty(405));
    }
    let mut hosts = request
        .headers()
        .iter()
        .filter(|header| header.field.equiv("Host"));
    if hosts.next().map(|header| header.value.as_str()) != Some(host) || hosts.next().is_some() {
        return request.respond(Response::empty(400));
    }
    let Some(relative) = asset_path(request.url()) else {
        return request.respond(Response::empty(400));
    };
    let local = relative.strip_prefix("local/");
    let local_endpoint =
        local.and_then(|_| endpoint.read().expect("controller endpoint lock").clone());
    if local.is_some() && local_endpoint.is_none() {
        return request.respond(Response::empty(404));
    }
    let path = local.map_or_else(|| relative.clone(), |path| format!("api/{path}"));
    if !paths.contains(&path) {
        return request.respond(Response::empty(404));
    }
    let Some(asset) = app.asset_resolver().get(path.clone()) else {
        return request.respond(Response::empty(404));
    };
    let body = if matches!(
        path.as_str(),
        "api/webapp-client.json" | "collaboration/webapp-client.json"
    ) {
        match bootstrap(&asset.bytes, local_endpoint.as_deref()) {
            Ok(body) => body,
            Err(error) => {
                eprintln!("Invalid bundled client bootstrap: {error}");
                return request.respond(Response::empty(500));
            }
        }
    } else {
        asset.bytes
    };
    let mut response = Response::from_data(body);
    for (name, value) in [
        ("Content-Type", asset.mime_type.as_str()),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        response.add_header(Header::from_bytes(name, value).expect("valid asset response header"));
    }
    if let Some(csp) = asset.csp_header {
        response.add_header(
            Header::from_bytes("Content-Security-Policy", csp).expect("valid bundled CSP"),
        );
    }
    request.respond(response)
}

fn bootstrap(bytes: &[u8], endpoint: Option<&str>) -> DesktopResult<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or("Expected a client bootstrap object.")?;
    match (object.get("mode").and_then(Value::as_str), endpoint) {
        (Some("remote"), Some(endpoint)) => {
            object.insert("apiBaseUrl".into(), endpoint.into());
        }
        (Some("remote" | "external"), None) => {}
        _ => return Err("Unexpected bundled client mode.".into()),
    }
    object.insert("connectionPickerUrl".into(), "../".into());
    serde_json::to_vec(&value).map_err(|error| error.to_string())
}
