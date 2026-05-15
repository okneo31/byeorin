// 노동자의 지갑 — Tauri 2 library entry point.
// Keeping the runtime in `lib.rs` makes mobile targets (iOS/Android) trivial later.

#[tauri::command]
fn greet(name: &str) -> String {
    format!("안녕하세요, {name}! 노동자의 지갑입니다.")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
