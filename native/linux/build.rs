fn main() {
    println!("cargo:rerun-if-env-changed=CLANKY_LINUX_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    tauri_build::build();
}
