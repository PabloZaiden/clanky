use crate::{
    network::{direct_endpoint, NetworkMode},
    queue, show_error, updates, Desktop, DesktopResult, Operation, UpdateChannel,
};
use gtk::{
    prelude::*, Align, Box as GtkBox, Dialog, DialogFlags, Label, Orientation, ResponseType,
};
use std::io::Write;
use tauri::{AppHandle, Manager};

fn parent(app: &AppHandle) -> Option<gtk::ApplicationWindow> {
    app.get_webview_window("main")
        .and_then(|window| window.gtk_window().ok())
}

fn field(container: &GtkBox, label: &str, widget: &impl IsA<gtk::Widget>) {
    let title = Label::new(Some(label));
    title.set_halign(Align::Start);
    container.pack_start(&title, false, false, 0);
    container.pack_start(widget, false, false, 0);
}

fn form(app: &AppHandle, title: &str, apply: &str) -> (Dialog, GtkBox) {
    let dialog = Dialog::with_buttons(
        Some(title),
        parent(app).as_ref(),
        DialogFlags::MODAL,
        &[
            ("Cancel", ResponseType::Cancel),
            (apply, ResponseType::Accept),
        ],
    );
    dialog.set_default_response(ResponseType::Accept);
    let content = dialog.content_area();
    content.set_border_width(16);
    content.set_spacing(8);
    (dialog, content)
}

pub fn network(app: &AppHandle) {
    let state = app.state::<Desktop>();
    let Ok(preferences) = state.preferences.try_lock() else {
        show_error(app, "Wait for the local controller operation to finish.");
        return;
    };
    let running = state
        .endpoint
        .read()
        .expect("controller endpoint lock")
        .is_some();
    let (dialog, content) = form(app, "Network Access", "Apply");
    let mode = gtk::ComboBoxText::new();
    mode.append(Some("local"), "Local Only");
    mode.append(Some("tailscale"), "Automatic Remote Access (Tailscale)");
    mode.append(Some("direct"), "Direct HTTPS");
    let endpoint = gtk::Entry::new();
    endpoint.set_input_purpose(gtk::InputPurpose::Url);
    endpoint.set_placeholder_text(Some("https://192.168.1.10:49372"));
    let current = match &preferences.settings.network {
        NetworkMode::Local => "local",
        NetworkMode::Tailscale => "tailscale",
        NetworkMode::Direct(url) => {
            endpoint.set_text(url);
            "direct"
        }
    };
    mode.set_active_id(Some(current));
    let direct = GtkBox::new(Orientation::Vertical, 6);
    field(&content, "Access", &mode);
    field(&direct, "Controller URL", &endpoint);
    let trust = Label::new(Some("Listens on all interfaces. Trust the exported certificate in your browser and system before connecting."));
    trust.set_halign(Align::Start);
    trust.set_line_wrap(true);
    trust.set_max_width_chars(55);
    direct.pack_start(&trust, false, false, 0);
    content.pack_start(&direct, false, false, 0);
    if running {
        let warning = Label::new(Some(
            "Applying a change restarts the controller and interrupts connections.",
        ));
        warning.set_halign(Align::Start);
        warning.set_line_wrap(true);
        warning.set_max_width_chars(55);
        content.pack_start(&warning, false, false, 0);
    }
    let error = Label::new(None);
    error.set_halign(Align::Start);
    error.set_line_wrap(true);
    error.set_max_width_chars(55);
    content.pack_start(&error, false, false, 0);
    let direct_fields = direct.clone();
    mode.connect_changed(move |mode| {
        direct_fields.set_visible(mode.active_id().as_deref() == Some("direct"))
    });
    let app = app.clone();
    dialog.connect_response(move |dialog, response| {
        if response == ResponseType::Accept {
            let selected = match mode.active_id().as_deref() {
                Some("local") => Ok(NetworkMode::Local),
                Some("tailscale") => Ok(NetworkMode::Tailscale),
                Some("direct") => {
                    direct_endpoint(endpoint.text().as_str()).map(NetworkMode::Direct)
                }
                _ => Err("Choose a network access mode.".into()),
            };
            match selected {
                Ok(mode) => queue(&app, Operation::Network(mode)),
                Err(message) => {
                    error.set_text(&message);
                    return;
                }
            }
        }
        dialog.close();
    });
    dialog.show_all();
    direct.set_visible(current == "direct");
}

pub fn owner(app: &AppHandle) {
    let (dialog, content) = form(app, "Initialize Owner Password", "Initialize");
    let username = gtk::Entry::new();
    let password = gtk::Entry::new();
    password.set_visibility(false);
    password.set_input_purpose(gtk::InputPurpose::Password);
    password.set_placeholder_text(Some("At least 12 characters"));
    field(&content, "Username", &username);
    field(&content, "Password", &password);
    let error = Label::new(None);
    error.set_halign(Align::Start);
    content.pack_start(&error, false, false, 0);
    let app = app.clone();
    dialog.connect_response(move |dialog, response| {
        if response == ResponseType::Accept {
            let secret = password.text();
            if username.text().trim().is_empty() || secret.chars().count() < 12 || secret.len() > 1024 {
                error.set_text("Enter a username and a password of at least 12 characters (at most 1024 bytes).");
                return;
            }
            password.set_text("");
            queue(&app, Operation::InitializeOwner {
                username: username.text().trim().into(), password: secret.to_string(),
            });
        } else {
            password.set_text("");
        }
        dialog.close();
    });
    dialog.show_all();
}

pub fn update_settings(app: &AppHandle) {
    let channel = app
        .state::<Desktop>()
        .preferences
        .lock()
        .expect("preferences lock")
        .update_channel(app);
    let (dialog, content) = form(app, "Update Settings", "Save");
    let installed = app.package_info().version.to_string();
    let version = Label::new(Some(updates::display_version(&installed)));
    version.set_halign(Align::Start);
    field(&content, "Installed Version", &version);

    let choices = gtk::ComboBoxText::new();
    choices.append_text("Stable");
    choices.append_text("Latest");
    choices.set_active(Some(match channel {
        UpdateChannel::Stable => 0,
        UpdateChannel::Latest => 1,
    }));
    field(&content, "Update Channel", &choices);
    let app = app.clone();
    dialog.connect_response(move |dialog, response| {
        if response == ResponseType::Accept {
            let channel = match choices.active() {
                Some(0) => UpdateChannel::Stable,
                Some(1) => UpdateChannel::Latest,
                _ => {
                    show_error(&app, "Choose an update channel.");
                    return;
                }
            };
            queue(&app, Operation::UpdateChannel(channel));
        }
        dialog.close();
    });
    dialog.show_all();
}

pub fn save_certificate(app: &AppHandle, contents: Vec<u8>) -> DesktopResult<()> {
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || {
            let chooser = gtk::FileChooserNative::new(
                Some("Export Controller Certificate"),
                parent(&app).as_ref(),
                gtk::FileChooserAction::Save,
                Some("Save"),
                Some("Cancel"),
            );
            chooser.set_current_name("clanky-controller.pem");
            chooser.set_do_overwrite_confirmation(true);
            chooser.connect_response(move |chooser, response| {
                if response == ResponseType::Accept {
                    let result = (|| -> DesktopResult<()> {
                        let path = chooser
                            .filename()
                            .ok_or("Choose a local file for the certificate.")?;
                        let directory = path
                            .parent()
                            .ok_or("The certificate directory is unavailable.")?;
                        let mut file = tempfile::NamedTempFile::new_in(directory)
                            .map_err(|error| error.to_string())?;
                        file.write_all(&contents)
                            .map_err(|error| error.to_string())?;
                        file.persist(path).map_err(|error| error.to_string())?;
                        Ok(())
                    })();
                    if let Err(error) = result {
                        show_error(&app, format!("Cannot export the certificate: {error}"));
                    }
                }
                chooser.destroy();
            });
            chooser.show();
        })
        .map_err(|error| error.to_string())
}

pub fn notice(app: &AppHandle, message: &'static str) -> DesktopResult<()> {
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || {
            let dialog = gtk::MessageDialog::new(
                parent(&app).as_ref(),
                DialogFlags::MODAL,
                gtk::MessageType::Info,
                gtk::ButtonsType::Close,
                message,
            );
            dialog.connect_response(|dialog, _| dialog.close());
            dialog.show();
        })
        .map_err(|error| error.to_string())
}

pub fn confirm_update(app: &AppHandle, version: &str) -> DesktopResult<bool> {
    let app = app.clone();
    let version = version.to_owned();
    let (result, receive) = std::sync::mpsc::channel();
    app.clone()
        .run_on_main_thread(move || {
            let dialog = gtk::MessageDialog::new(
                parent(&app).as_ref(),
                DialogFlags::MODAL,
                gtk::MessageType::Question,
                gtk::ButtonsType::None,
                &format!("Install Clanky {version}?"),
            );
            dialog.set_secondary_text(Some("Clanky will stop its local controller and restart."));
            dialog.add_button("Cancel", ResponseType::Cancel);
            dialog.add_button("Install and Restart", ResponseType::Accept);
            let accepted = dialog.run() == ResponseType::Accept;
            dialog.close();
            if result.send(accepted).is_err() {
                eprintln!("Clanky update confirmation was not received.");
            }
        })
        .map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())
}
