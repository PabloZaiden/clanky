mod assets;
mod controller;
mod network;
mod updates;

use controller::Controller;
use network::NetworkMode;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::{fs::DirBuilderExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    time::Duration,
};
use updates::UpdateChannel;
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

type DesktopResult<T> = Result<T, String>;
type SharedEndpoint = Arc<RwLock<Option<String>>>;
const UPDATE_RESTART: i32 = 42;

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Settings {
    port: u16,
    automatic: bool,
    connection: Option<Connection>,
    network: NetworkMode,
    update_channel: Option<UpdateChannel>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
enum Connection {
    Api,
    Collaboration,
}

struct Preferences {
    path: PathBuf,
    settings: Settings,
}

impl Preferences {
    fn open(root: &Path) -> DesktopResult<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)
            .map_err(|error| format!("Cannot create the Clanky desktop directory: {error}"))?;
        let path = root.join("desktop.json");
        let settings = match fs::read(&path) {
            Ok(contents) => serde_json::from_slice(&contents)
                .map_err(|error| format!("Cannot parse the Clanky desktop settings: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(error) => return Err(format!("Cannot read the Clanky desktop settings: {error}")),
        };
        Ok(Self { path, settings })
    }

    fn write(&self) -> DesktopResult<()> {
        let mut file =
            tempfile::NamedTempFile::new_in(self.path.parent().expect("settings parent"))
                .map_err(|error| format!("Cannot create a temporary settings file: {error}"))?;
        serde_json::to_writer(&mut file, &self.settings)
            .map_err(|error| format!("Cannot write the Clanky desktop settings: {error}"))?;
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|error| format!("Cannot save the Clanky desktop settings: {error}"))?;
        file.persist(&self.path)
            .map_err(|error| format!("Cannot replace the Clanky desktop settings: {error}"))?;
        Ok(())
    }

    fn set_automatic(&mut self, value: bool) -> DesktopResult<()> {
        if self.settings.automatic == value {
            return Ok(());
        }
        let previous = self.settings.automatic;
        self.settings.automatic = value;
        if let Err(error) = self.write() {
            self.settings.automatic = previous;
            return Err(error);
        }
        Ok(())
    }

    fn update_channel(&self, app: &AppHandle) -> UpdateChannel {
        self.settings
            .update_channel
            .unwrap_or_else(|| UpdateChannel::from_prerelease(app.package_info().version.pre.as_str()))
    }
}

struct Desktop {
    origin: Url,
    preferences: Mutex<Preferences>,
    endpoint: SharedEndpoint,
    menu: DesktopMenu,
    controller_menu: Mutex<ControllerMenuState>,
    busy: AtomicBool,
    quitting: AtomicBool,
    commands: mpsc::Sender<Operation>,
}

struct ControllerMenuState {
    has_process: bool,
    direct_https: bool,
}

struct DesktopMenu {
    start: MenuItem<tauri::Wry>,
    connect: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    network: MenuItem<tauri::Wry>,
    owner: MenuItem<tauri::Wry>,
    certificate: MenuItem<tauri::Wry>,
    copy_link: MenuItem<tauri::Wry>,
    update: MenuItem<tauri::Wry>,
    update_settings: MenuItem<tauri::Wry>,
}

enum Operation {
    Start,
    Restore,
    Stop,
    Quit,
    Network(NetworkMode),
    InitializeOwner { username: String, password: String },
    ExportCertificate,
    Update,
    UpdateChannel(UpdateChannel),
}

fn refresh_menu(app: &AppHandle) {
    let state = app.state::<Desktop>();
    let menu = &state.menu;
    let idle = !state.busy.load(Ordering::Acquire);
    let (has_process, direct_https) = {
        let controller = state.controller_menu.lock().expect("controller menu lock");
        (controller.has_process, controller.direct_https)
    };
    let (ready, remote) = {
        let endpoint = state.endpoint.read().expect("controller endpoint lock");
        (
            endpoint.is_some(),
            endpoint.as_ref().is_some_and(|url| url.starts_with("https://")),
        )
    };
    let can_update = idle && updates::available(app);
    for (item, enabled) in [
        (&menu.start, idle && !has_process),
        (&menu.connect, idle && ready),
        (&menu.stop, idle && has_process),
        (&menu.network, idle),
        (&menu.owner, idle),
        (&menu.certificate, idle && direct_https),
        (&menu.copy_link, idle && remote),
        (&menu.update, can_update),
        (&menu.update_settings, can_update),
    ] {
        if let Err(error) = item.set_enabled(enabled) {
            show_error(app, format!("Cannot refresh the Clanky menu: {error}"));
            break;
        }
    }
}

fn dispatch_menu_refresh(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || refresh_menu(&handle)) {
        show_error(app, format!("Cannot dispatch a Clanky menu refresh: {error}"));
    }
}

fn show_error(app: &AppHandle, message: impl Into<String>) {
    use gtk::prelude::*;
    let message = message.into();
    eprintln!("Clanky: {message}");
    let app = app.clone();
    let dispatch = app.clone().run_on_main_thread(move || {
        let window = app
            .get_webview_window("main")
            .and_then(|window| window.gtk_window().ok());
        let dialog = gtk::MessageDialog::new(
            window.as_ref(),
            gtk::DialogFlags::MODAL,
            gtk::MessageType::Error,
            gtk::ButtonsType::Close,
            &message,
        );
        dialog.connect_response(|dialog, _| dialog.close());
        dialog.show();
    });
    if let Err(error) = dispatch {
        eprintln!("Cannot show the Clanky error dialog: {error}");
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        return;
    }
    if let Err(error) =
        gtk::gio::AppInfo::launch_default_for_uri(url.as_str(), None::<&gtk::gio::AppLaunchContext>)
    {
        show_error(app, format!("Cannot open the system browser: {error}"));
    }
}

fn navigate(app: &AppHandle, path: &str) -> DesktopResult<()> {
    let state = app.state::<Desktop>();
    let url = state.origin.join(path).map_err(|error| error.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or("The Clanky window is not available.")?;
    window
        .navigate(url)
        .map_err(|error| format!("Cannot open the Clanky page: {error}"))
}

fn do_menu(app: &AppHandle, action: &str) {
    let state = app.state::<Desktop>();
    match action {
        "connect" => {
            if state
                .endpoint
                .read()
                .expect("controller endpoint lock")
                .is_some()
            {
                if let Err(error) = navigate(app, "local/") {
                    show_error(app, error);
                }
            } else {
                show_error(app, "The local controller is not running.");
            }
        }
        "start" => queue(app, Operation::Start),
        "restore" => queue(app, Operation::Restore),
        "stop" => queue(app, Operation::Stop),
        "quit" => queue(app, Operation::Quit),
        "network" => dialogs::network(app),
        "owner" => dialogs::owner(app),
        "certificate" => queue(app, Operation::ExportCertificate),
        "update" => queue(app, Operation::Update),
        "update-settings" => dialogs::update_settings(app),
        "copy-link" => {
            let endpoint = state.endpoint.read().expect("controller endpoint lock");
            if let Some(link) = endpoint
                .as_deref()
                .filter(|url| url.starts_with("https://"))
            {
                if let Some(display) = gtk::gdk::Display::default() {
                    if let Some(clipboard) = gtk::Clipboard::default(&display) {
                        clipboard.set_text(link);
                        return;
                    }
                }
                show_error(app, "The clipboard is unavailable.");
            } else {
                show_error(app, "The controller does not have a remote link.");
            }
        }
        _ => {}
    }
}

fn queue(app: &AppHandle, operation: Operation) {
    let state = app.state::<Desktop>();
    if state.busy.swap(true, Ordering::AcqRel) {
        show_error(app, "Wait for the local controller operation to finish.");
        return;
    }
    refresh_menu(app);
    if state.commands.send(operation).is_err() {
        state.busy.store(false, Ordering::Release);
        refresh_menu(app);
        show_error(app, "The local controller supervisor is unavailable.");
    }
}

fn supervise(app: AppHandle, mut controller: Controller, commands: mpsc::Receiver<Operation>) {
    let state = app.state::<Desktop>();
    loop {
        match commands.recv_timeout(Duration::from_millis(500)) {
            Ok(operation) => {
                let result = controller_action(&app, &state, &mut controller, operation);
                {
                    let mut menu = state.controller_menu.lock().expect("controller menu lock");
                    menu.has_process = controller.has_owned_process();
                    menu.direct_https = matches!(
                        state.preferences.lock().expect("preferences lock").settings.network,
                        NetworkMode::Direct(_)
                    );
                }
                state.busy.store(false, Ordering::Release);
                if let Err(error) = result {
                    show_error(&app, error);
                }
                if state.quitting.load(Ordering::Acquire) {
                    break;
                }
                dispatch_menu_refresh(&app);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(error) = controller.monitor() {
                    state
                        .controller_menu
                        .lock()
                        .expect("controller menu lock")
                        .has_process = controller.has_owned_process();
                    dispatch_menu_refresh(&app);
                    show_error(&app, error);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn on_local_page(app: &AppHandle) -> DesktopResult<bool> {
    let window = app
        .get_webview_window("main")
        .ok_or("The Clanky window is not available.")?;
    Ok(window
        .url()
        .map_err(|error| error.to_string())?
        .path()
        .starts_with("/local/"))
}

fn controller_action(
    app: &AppHandle,
    state: &Desktop,
    controller: &mut Controller,
    action: Operation,
) -> DesktopResult<()> {
    match action {
        Operation::Start | Operation::Restore => {
            let mut preferences = state.preferences.lock().expect("preferences lock");
            let result = controller.start(&mut preferences);
            drop(preferences);
            result?;
            navigate(app, "local/")
        }
        Operation::Stop => {
            controller.stop()?;
            state
                .preferences
                .lock()
                .expect("preferences lock")
                .set_automatic(false)?;
            if on_local_page(app)? {
                navigate(app, "")?;
            }
            Ok(())
        }
        Operation::Quit => {
            controller.stop()?;
            state.quitting.store(true, Ordering::Release);
            app.exit(0);
            Ok(())
        }
        Operation::Network(mode) => {
            let mut preferences = state.preferences.lock().expect("preferences lock");
            if preferences.settings.network == mode {
                return Ok(());
            }
            controller.prepare_network(&mode)?;
            let was_running = controller.is_running()?;
            if was_running {
                controller.stop()?;
            }
            let previous = std::mem::replace(&mut preferences.settings.network, mode);
            if let Err(error) = preferences.write() {
                preferences.settings.network = previous;
                return Err(error);
            }
            let result = if was_running {
                controller.start(&mut preferences)
            } else {
                Ok(())
            };
            drop(preferences);
            if let Err(error) = result {
                if on_local_page(app)? {
                    navigate(app, "")?;
                }
                return Err(error);
            }
            if was_running && on_local_page(app)? {
                navigate(app, "local/")?;
            }
            Ok(())
        }
        Operation::InitializeOwner { username, password } => {
            controller.initialize_owner(&username, &password)
        }
        Operation::ExportCertificate => dialogs::save_certificate(app, controller.certificate()?),
        Operation::UpdateChannel(channel) => {
            let mut preferences = state.preferences.lock().expect("preferences lock");
            let previous = preferences.settings.update_channel.replace(channel);
            if let Err(error) = preferences.write() {
                preferences.settings.update_channel = previous;
                return Err(error);
            }
            Ok(())
        }
        Operation::Update => {
            let channel = state
                .preferences
                .lock()
                .expect("preferences lock")
                .update_channel(app);
            if updates::apply(app, controller, channel)? {
                state.quitting.store(true, Ordering::Release);
                app.exit(UPDATE_RESTART);
            } else if on_local_page(app)?
                && state
                    .endpoint
                    .read()
                    .expect("controller endpoint lock")
                    .is_none()
            {
                navigate(app, "")?;
            }
            Ok(())
        }
    }
}

fn setup(app: &mut tauri::App) -> DesktopResult<()> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let mut preferences = Preferences::open(&root)?;
    let listener = assets::bind(preferences.settings.port)?;
    if preferences.settings.port == 0 {
        preferences.settings.port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        preferences.write()?;
    }
    let endpoint = SharedEndpoint::default();
    let controller = Controller::new(root.join("Controller"), endpoint.clone())?;
    let origin = assets::serve(app.handle().clone(), listener, endpoint.clone())?;
    let automatic = preferences.settings.automatic;
    let direct_https = matches!(preferences.settings.network, NetworkMode::Direct(_));
    let initial_path = match preferences.settings.connection {
        Some(Connection::Api) => "api/",
        Some(Connection::Collaboration) => "collaboration/",
        None => "",
    };
    let (commands, receive_commands) = mpsc::channel();
    let start = MenuItem::with_id(app, "start", "Start Local Controller", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let connect = MenuItem::with_id(
        app,
        "connect",
        "Connect to Local Controller",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let stop = MenuItem::with_id(app, "stop", "Stop Local Controller", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let network = MenuItem::with_id(app, "network", "Network Access...", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let owner = MenuItem::with_id(
        app,
        "owner",
        "Initialize Owner Password...",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let certificate = MenuItem::with_id(
        app,
        "certificate",
        "Export Controller Certificate...",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let copy_link = MenuItem::with_id(app, "copy-link", "Copy Remote Link", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, Some("Ctrl+Q")).map_err(|e| e.to_string())?;
    let update = MenuItem::with_id(app, "update", "Check for Updates...", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let update_settings = MenuItem::with_id(
        app,
        "update-settings",
        "Update Settings...",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let local = Submenu::with_items(
        app,
        "Local Controller",
        true,
        &[
            &start,
            &connect,
            &stop,
            &network,
            &owner,
            &certificate,
            &copy_link,
        ],
    )
    .map_err(|e| e.to_string())?;
    let file = Submenu::with_items(app, "File", true, &[&update, &update_settings, &quit])
        .map_err(|e| e.to_string())?;
    app.manage(Desktop {
        origin: origin.clone(),
        preferences: Mutex::new(preferences),
        endpoint,
        menu: DesktopMenu {
            start,
            connect,
            stop,
            network,
            owner,
            certificate,
            copy_link,
            update,
            update_settings,
        },
        controller_menu: Mutex::new(ControllerMenuState {
            has_process: false,
            direct_https,
        }),
        commands,
        busy: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
    });
    refresh_menu(app.handle());
    app.set_menu(Menu::with_items(app, &[&file, &local]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    app.on_menu_event(|app, event| do_menu(app, event.id().as_ref()));

    let app_handle = app.handle().clone();
    let popup_app = app_handle.clone();
    let navigation_origin = origin.origin();
    let script_origin = serde_json::to_string(origin.origin().ascii_serialization().as_str())
        .map_err(|e| e.to_string())?;
    let script = format!(
        r#"if (location.origin === {script_origin}) {{
          window.clankyLocalController = location.pathname.startsWith("/local/");
          window.clankyOpenAuthorizationUrl = url => {{ location.assign(url); }};
        }}"#
    );
    let window = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(origin.join(initial_path).map_err(|e| e.to_string())?),
    )
    .title("Clanky")
    .inner_size(1150.0, 800.0)
    .initialization_script(script)
    .on_navigation(move |url| {
        if url.origin() != navigation_origin {
            open_external(&app_handle, url);
            return false;
        }
        // Navigation can occur during controller startup. Avoid blocking the GTK thread.
        if let Ok(mut preferences) = app_handle.state::<Desktop>().preferences.try_lock() {
            let connection = match url.path() {
                "/" => Some(None),
                "/api/" => Some(Some(Connection::Api)),
                "/collaboration/" => Some(Some(Connection::Collaboration)),
                _ => None,
            };
            if let Some(connection) = connection {
                preferences.settings.connection = connection;
                if let Err(error) = preferences.write() {
                    show_error(&app_handle, error);
                }
            }
        }
        true
    })
    .on_new_window(move |url, _| {
        open_external(&popup_app, &url);
        NewWindowResponse::Deny
    })
    .build()
    .map_err(|e| e.to_string())?;

    let window_app = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if !window_app
                .state::<Desktop>()
                .quitting
                .load(Ordering::Acquire)
            {
                api.prevent_close();
                do_menu(&window_app, "quit");
            }
        }
    });
    let supervisor = app.handle().clone();
    std::thread::Builder::new()
        .name("clanky-controller".into())
        .spawn(move || supervise(supervisor, controller, receive_commands))
        .map_err(|error| format!("Cannot start the controller supervisor: {error}"))?;
    if automatic {
        do_menu(app.handle(), "restore");
    }
    Ok(())
}

mod dialogs;

fn show_startup_error(message: &str) {
    eprintln!("{message}");
    if gtk::init().is_ok() {
        use gtk::prelude::*;
        let dialog = gtk::MessageDialog::new(
            None::<&gtk::Window>,
            gtk::DialogFlags::MODAL,
            gtk::MessageType::Error,
            gtk::ButtonsType::Close,
            message,
        );
        dialog.run();
        dialog.close();
    }
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Err(error) = setup(app) {
                show_startup_error(&format!("Cannot open Clanky: {error}"));
                app.handle().exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let failure = match result {
        Ok(app) => {
            let env = app.env();
            let image = env.appimage.clone();
            let args = env.args_os.clone();
            let code = app.run_return(|_, _| {});
            if code != UPDATE_RESTART {
                std::process::exit(code);
            }
            match image {
                Some(image) => {
                    // Exec closes the old listener before the updated AppImage can bind it.
                    let error = Command::new(image).args(args.iter().skip(1)).exec();
                    format!("Cannot reopen the updated Clanky AppImage: {error}")
                }
                None => "The updated Clanky AppImage path is unavailable.".into(),
            }
        }
        Err(error) => format!("Cannot open Clanky: {error}"),
    };
    show_startup_error(&failure);
    std::process::exit(1);
}
