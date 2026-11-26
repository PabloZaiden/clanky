use crate::{
    network::{
        direct_endpoint, LaunchNetwork, NetworkMode, ServeConfig, TailscaleStatus,
        LOOPBACK_BACKEND, SERVE_PORT_ARGUMENT,
    },
    DesktopResult, Preferences, SharedEndpoint,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{Read, Seek, Write},
    net::TcpListener,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const PORT: u16 = 49372;

pub struct Controller {
    directory: PathBuf,
    executable: PathBuf,
    endpoint: SharedEndpoint,
    process: Option<Child>,
    publication: Option<Child>,
}

impl Controller {
    pub fn new(directory: PathBuf, endpoint: SharedEndpoint) -> DesktopResult<Self> {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable.with_file_name("clanky-controller");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .map_err(|error| format!("Cannot create the app controller directory: {error}"))?;
        Ok(Self {
            directory,
            executable,
            endpoint,
            process: None,
            publication: None,
        })
    }

    fn log_path(&self) -> PathBuf {
        self.directory.join("app-controller.log")
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        for (key, _) in
            env::vars_os().filter(|(key, _)| key.to_string_lossy().starts_with("CLANKY_"))
        {
            command.env_remove(key);
        }
        command
            .env("CLANKY_DATA_DIR", &self.directory)
            .current_dir(&self.directory)
            .env("BUN_OPTIONS", "--no-env-file")
            .stdin(Stdio::null());
        command
    }

    pub fn is_running(&mut self) -> DesktopResult<bool> {
        self.reap()?;
        Ok(self.process.is_some())
    }

    pub fn has_owned_process(&self) -> bool {
        self.process.is_some() || self.publication.is_some()
    }

    pub fn authorize_network(&self) -> DesktopResult<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AuthStatus {
            owner_exists: bool,
            auth_initialized: bool,
            password_configured: bool,
        }
        let status: AuthStatus = serde_json::from_slice(&self.cli(&["auth", "status"], None)?)
            .map_err(|error| format!("Cannot read local owner status: {error}"))?;
        if !(status.owner_exists && status.auth_initialized && status.password_configured) {
            return Err("Set an owner password before enabling remote access. Initialize the owner with Local Controller > Initialize Owner Password, or add a password in Account Settings while using Local Only.".into());
        }
        Ok(())
    }

    pub fn initialize_owner(&self, username: &str, password: &str) -> DesktopResult<()> {
        self.cli(
            &["auth", "setup", "--username", username, "--password-stdin"],
            Some(password),
        )?;
        Ok(())
    }

    pub fn certificate(&self) -> DesktopResult<Vec<u8>> {
        self.cli(&["controller", "tls", "export"], None)
    }

    fn cli(&self, args: &[&str], input: Option<&str>) -> DesktopResult<Vec<u8>> {
        run_command(self.command().args(args), input)
    }

    pub fn prepare_network(&self, mode: &NetworkMode) -> DesktopResult<LaunchNetwork> {
        match mode {
            NetworkMode::Local => Ok(LaunchNetwork::local()),
            NetworkMode::Tailscale => {
                self.authorize_network()?;
                let status: TailscaleStatus =
                    serde_json::from_slice(&tailscale(&["status", "--json"])?)
                        .map_err(|error| format!("Cannot read Tailscale status: {error}"))?;
                let endpoint = status.endpoint()?;
                if serve_status()?.uses_https_port() {
                    return Err("Tailscale HTTPS port 443 is already in use. Existing routes were not changed.".into());
                }
                Ok(LaunchNetwork {
                    endpoint,
                    certificate: None,
                    tailscale: true,
                })
            }
            NetworkMode::Direct(input) => {
                self.authorize_network()?;
                let endpoint = direct_endpoint(input)?;
                self.cli(
                    &["controller", "tls", "enable", "--endpoint", &endpoint],
                    None,
                )?;
                Ok(LaunchNetwork {
                    endpoint,
                    certificate: Some(self.certificate()?),
                    tailscale: false,
                })
            }
        }
    }

    pub fn start(&mut self, preferences: &mut Preferences) -> DesktopResult<()> {
        self.reap()?;
        if self.process.is_some() {
            return if self
                .endpoint
                .read()
                .expect("controller endpoint lock")
                .is_some()
            {
                Ok(())
            } else {
                Err("Stop the controller before attempting to start it again.".into())
            };
        }
        let network = self.prepare_network(&preferences.settings.network)?;
        TcpListener::bind((network.listener().as_str(), PORT)).map_err(|error| {
            format!("Cannot start the local controller on port {PORT}: {error}")
        })?;
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.log_path())
            .map_err(|error| format!("Cannot open the controller log: {error}"))?;
        let ready = tempfile::Builder::new()
            .prefix("start-")
            .tempdir_in(&self.directory)
            .map_err(|error| format!("Cannot prepare controller startup: {error}"))?;
        let marker = ready.path().join("ready");
        let mut command = self.command();
        command
            .args(["serve", "--api-only", "true"])
            .env("CLANKY_HOST", network.listener())
            .env("CLANKY_PORT", PORT.to_string())
            .env("CLANKY_PUBLIC_BASE_URL", &network.endpoint)
            .env(
                "CLANKY_MANAGED_TLS",
                if network.certificate.is_some() {
                    "true"
                } else {
                    "false"
                },
            )
            .env(
                "CLANKY_TRUST_PROXY",
                if network.tailscale { "true" } else { "false" },
            )
            .env("CLANKY_DESKTOP_READY_FILE", &marker)
            .stdout(log.try_clone().map_err(|error| error.to_string())?)
            .stderr(log);
        if network.tailscale {
            command
                .env("CLANKY_TRUST_PROXY_HEADERS", "proto")
                .env("CLANKY_TRUST_PROXY_CHAIN", "first");
        }
        let child = spawn_owned(&mut command)
            .map_err(|error| format!("Cannot launch the bundled Clanky controller: {error}"))?;
        let pid = child.id();
        self.process = Some(child);
        if let Err(error) = self.wait_until_ready(&marker, pid, &network) {
            let error = format!("{error}\nLog: {}", self.log_path().display());
            return match self.stop() {
                Ok(()) => Err(error),
                Err(stop) => Err(format!("{error}\n{stop}")),
            };
        }
        if network.tailscale {
            if let Err(error) = self.publish(&network.endpoint) {
                return match self.stop() {
                    Ok(()) => Err(error),
                    Err(stop) => Err(format!("{error}\n{stop}")),
                };
            }
        }
        *self.endpoint.write().expect("controller endpoint lock") = Some(network.endpoint);
        preferences.set_automatic(true)
    }

    fn wait_until_ready(
        &mut self,
        marker: &Path,
        pid: u32,
        network: &LaunchNetwork,
    ) -> DesktopResult<()> {
        let client = health_client(network.certificate.as_deref())?;
        let health = format!("{}/api/health", network.backend());
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut failure = "The startup marker was not written.".to_owned();
        while Instant::now() < deadline {
            if let Some(status) = self.reap()? {
                return Err(format!(
                    "The local controller exited during startup ({status})."
                ));
            }
            if fs::read_to_string(marker).is_ok_and(|content| content.trim() == pid.to_string()) {
                match check_health(&client, &health) {
                    Ok(()) if self.reap()?.is_none() => return Ok(()),
                    Ok(()) => return Err("The local controller exited during startup.".into()),
                    Err(error) => failure = error,
                }
            }
            thread::sleep(Duration::from_millis(75));
        }
        Err(format!(
            "The local controller did not become ready: {failure}"
        ))
    }

    pub fn reap(&mut self) -> DesktopResult<Option<ExitStatus>> {
        let status = match self.process.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|error| format!("Cannot read controller status: {error}"))?,
            None => None,
        };
        if status.is_some() {
            self.process = None;
            *self.endpoint.write().expect("controller endpoint lock") = None;
            self.stop_publication()?;
        }
        Ok(status)
    }

    pub fn monitor(&mut self) -> DesktopResult<()> {
        if let Some(status) = self.reap()? {
            return Err(format!(
                "The local controller exited ({status}).\nLog: {}",
                self.log_path().display()
            ));
        }
        if let Some(process) = self.publication.as_mut() {
            if let Some(status) = process.try_wait().map_err(|error| error.to_string())? {
                self.publication = None;
                let message = format!(
                    "Tailscale Serve ended ({status}).\nLog: {}",
                    self.tailscale_log().display()
                );
                return match self.stop() {
                    Ok(()) => Err(message),
                    Err(error) => Err(format!("{message}\n{error}")),
                };
            }
        }
        Ok(())
    }

    fn tailscale_log(&self) -> PathBuf {
        self.directory.join("app-tailscale.log")
    }

    fn publish(&mut self, endpoint: &str) -> DesktopResult<()> {
        let log = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(self.tailscale_log())
            .map_err(|error| error.to_string())?;
        let mut command = Command::new("tailscale");
        command
            .args(["serve", SERVE_PORT_ARGUMENT, LOOPBACK_BACKEND])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|error| error.to_string())?)
            .stderr(log);
        let process = spawn_owned(&mut command)
            .map_err(|error| format!("Cannot start Tailscale Serve: {error}"))?;
        self.publication = Some(process);
        let health = format!("{endpoint}/api/health");
        let client = health_client(None)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !self.is_running()? {
                return Err("The controller exited while starting Tailscale Serve.".into());
            }
            let Some(process) = self.publication.as_mut() else {
                return Err("Tailscale Serve stopped during startup.".into());
            };
            if let Some(status) = process.try_wait().map_err(|error| error.to_string())? {
                self.publication = None;
                return Err(format!(
                    "Tailscale Serve stopped ({status}). Enable Serve/HTTPS if required.\nLog: {}",
                    self.tailscale_log().display()
                ));
            }
            if serve_status()?.has_foreground_proxy(endpoint)
                && check_health(&client, &health).is_ok()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err(format!(
            "Tailscale HTTPS was not ready. Check whether Serve needs approval.\nLog: {}",
            self.tailscale_log().display()
        ))
    }

    fn stop_publication(&mut self) -> DesktopResult<()> {
        let Some(process) = self.publication.as_mut() else {
            return Ok(());
        };
        if process
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            signal(process, libc::SIGTERM)?;
            let deadline = Instant::now() + Duration::from_secs(3);
            while process
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                if Instant::now() >= deadline {
                    process.kill().map_err(|error| {
                        format!("Cannot close the owned Tailscale session: {error}")
                    })?;
                    process.wait().map_err(|error| error.to_string())?;
                    break;
                }
                thread::sleep(Duration::from_millis(75));
            }
        }
        self.publication = None;
        Ok(())
    }

    pub fn stop(&mut self) -> DesktopResult<()> {
        self.stop_publication()?;
        self.reap()?;
        let Some(child) = self.process.as_ref() else {
            return Ok(());
        };
        *self.endpoint.write().expect("controller endpoint lock") = None;
        signal(child, libc::SIGTERM)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = self.reap()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "Controller shutdown exited with {status}.\nLog: {}",
                        self.log_path().display()
                    ))
                };
            }
            thread::sleep(Duration::from_millis(75));
        }
        Err(format!(
            "The controller is still shutting down.\nLog: {}",
            self.log_path().display()
        ))
    }
}

fn tailscale(args: &[&str]) -> DesktopResult<Vec<u8>> {
    run_command(Command::new("tailscale").args(args), None)
}

fn serve_status() -> DesktopResult<ServeConfig> {
    let bytes = tailscale(&["serve", "status", "--json"])?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Cannot inspect Tailscale Serve configuration: {error}"))
}

fn health_client(certificate: Option<&[u8]>) -> DesktopResult<reqwest::blocking::Client> {
    let mut client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pem) = certificate {
        // The managed certificate is both the authority and the server identity.
        let certificate = reqwest::Certificate::from_pem(pem)
            .map_err(|error| format!("Cannot trust the local certificate: {error}"))?;
        client = client
            .tls_built_in_root_certs(false)
            .add_root_certificate(certificate);
    }
    client.build().map_err(|error| error.to_string())
}

fn check_health(client: &reqwest::blocking::Client, endpoint: &str) -> DesktopResult<()> {
    let response = client
        .get(endpoint)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("{error:?}"))?;
    let body: Value = serde_json::from_reader(response.take(4096))
        .map_err(|error| format!("Cannot read controller health: {error}"))?;
    if body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("The controller did not report healthy status.".into());
    }
    Ok(())
}

fn run_command(command: &mut Command, input: Option<&str>) -> DesktopResult<Vec<u8>> {
    let mut output = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut errors = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(output.try_clone().map_err(|error| error.to_string())?)
        .stderr(errors.try_clone().map_err(|error| error.to_string())?)
        .spawn()
        .map_err(|error| {
            format!(
                "Cannot run {}: {error}",
                command.get_program().to_string_lossy()
            )
        })?;
    if let Some(input) = input {
        let result = writeln!(child.stdin.take().expect("piped command stdin"), "{input}");
        if let Err(error) = result {
            child
                .kill()
                .and_then(|_| child.wait())
                .map_err(|cleanup| format!("{error}; cleanup failed: {cleanup}"))?;
            return Err(format!("Cannot send local command input: {error}"));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let file = if status.success() {
                &mut output
            } else {
                &mut errors
            };
            file.rewind().map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            file.take(256 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            return if status.success() {
                Ok(bytes)
            } else {
                Err(format!(
                    "{} exited with {status}: {}",
                    command.get_program().to_string_lossy(),
                    String::from_utf8_lossy(&bytes).trim()
                ))
            };
        }
        if Instant::now() >= deadline {
            child
                .kill()
                .and_then(|_| child.wait())
                .map_err(|error| format!("Local command timed out; cleanup failed: {error}"))?;
            return Err(format!(
                "{} timed out.",
                command.get_program().to_string_lossy()
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn spawn_owned(command: &mut Command) -> std::io::Result<Child> {
    let parent = std::process::id() as libc::pid_t;
    // Called only on the dedicated worker thread: Linux ties this to that thread's lifetime.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
    command.spawn()
}

fn signal(child: &Child, number: libc::c_int) -> DesktopResult<()> {
    let result = unsafe { libc::kill(child.id() as libc::pid_t, number) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(format!("Cannot signal the app-owned process: {error}"))
}
