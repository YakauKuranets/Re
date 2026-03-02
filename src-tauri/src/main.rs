#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::State;
use zeroize::Zeroize;
use warp::Filter;
use serde_json::Value;

struct StreamState {
    active_streams: Mutex<HashMap<String, std::process::Child>>,
}

fn get_vault_path() -> PathBuf {
    let path = PathBuf::from(r"D:\Nemesis_Vault\recon_db");
    if !path.exists() { let _ = std::fs::create_dir_all(&path); }
    path
}

fn derive_hardware_key() -> [u8; 32] {
    let mut hw_id = machine_uid::get().unwrap_or_else(|_| "NEMESIS_FALLBACK_ID_777".to_string());
    let mut hasher = Sha256::new();
    hasher.update(hw_id.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&hasher.finalize());
    hw_id.zeroize();
    key
}

// --- БЛОК КОМАНД БАЗЫ ДАННЫХ ---

#[tauri::command]
fn save_target(target_id: String, payload: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e| e.to_string())?;
    let hw_key = derive_hardware_key();
    let cipher = Aes256Gcm::new(&hw_key.into());
    let nonce = Nonce::from_slice(b"nemesis_salt");
    let encrypted_data = cipher.encrypt(nonce, payload.as_bytes()).map_err(|_| "Encryption failed".to_string())?;
    db.insert(target_id.as_bytes(), encrypted_data).map_err(|e| e.to_string())?;
    Ok(format!("Saved: {}", target_id))
}

#[tauri::command]
fn read_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e| e.to_string())?;
    if let Some(data) = db.get(target_id.as_bytes()).map_err(|e| e.to_string())? {
        let hw_key = derive_hardware_key();
        let cipher = Aes256Gcm::new(&hw_key.into());
        let nonce = Nonce::from_slice(b"nemesis_salt");
        let decrypted = cipher.decrypt(nonce, data.as_ref()).map_err(|_| "Access denied".to_string())?;
        String::from_utf8(decrypted).map_err(|_| "UTF-8 error".to_string())
    } else { Err("Not found".to_string()) }
}

#[tauri::command]
fn get_all_targets() -> Result<Vec<String>, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e| e.to_string())?;
    let mut keys = Vec::new();
    for k in db.iter().keys() {
        if let Ok(key_bytes) = k {
            if let Ok(s) = String::from_utf8(key_bytes.to_vec()) { keys.push(s); }
        }
    }
    Ok(keys)
}

#[tauri::command]
fn delete_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e| e.to_string())?;
    db.remove(target_id.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("Deleted: {}", target_id))
}

// --- БЛОК РАЗВЕДКИ ---

#[tauri::command]
async fn probe_rtsp_path(host: String, login: String, pass: String) -> Result<String, String> {
    let signatures = vec![
        "/Streaming/Channels/101",
        "/cam/realmonitor?channel=1&subtype=0",
        "/user={u}&password={p}&channel=1&stream=0.sdp",
        "/live/ch1",
        "/h264/ch1/main/av_stream",
        "/mpeg4/ch1/main/av_stream",
        "/unicast/c1/s0/live",
        "/video1",
    ];
    let ffmpeg = get_vault_path().join("ffmpeg.exe");
    for sig in signatures {
        let path = sig.replace("{u}", &login).replace("{p}", &pass);
        let url = if login.is_empty() { format!("rtsp://{}/{}", host, path.trim_start_matches('/')) }
        else { format!("rtsp://{}:{}@{}/{}", login, pass, host, path.trim_start_matches('/')) };
        let s = Command::new(&ffmpeg).args(["-rtsp_transport", "tcp", "-timeout", "4000000", "-i", &url, "-t", "0.1", "-f", "null", "-"]).status();
        if let Ok(status) = s { if status.success() { return Ok(path); } }
    }
    Err("Recon failed".into())
}

// --- БЛОК ТРАНСЛЯЦИИ ---

#[tauri::command]
fn start_stream(target_id: String, rtsp_url: String, state: State<'_, StreamState>) -> Result<String, String> {
    let cache = get_vault_path().join("hls_cache").join(&target_id);
    let _ = std::fs::create_dir_all(&cache);
    let playlist = cache.join("stream.m3u8");
    {
        let mut streams = state.active_streams.lock().unwrap();
        if let Some(mut old) = streams.remove(&target_id) { let _ = old.kill(); }
    }
    let child = Command::new(get_vault_path().join("ffmpeg.exe"))
        .args([
            "-rtsp_transport", "tcp", "-y", "-i", &rtsp_url,
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-an",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "10",
            "-hls_flags", "delete_segments+append_list+discont_start",
            playlist.to_str().unwrap()
        ])
        .spawn().map_err(|e| e.to_string())?;
    state.active_streams.lock().unwrap().insert(target_id, child);
    Ok("Started".into())
}

#[tauri::command]
fn stop_stream(target_id: String, state: State<'_, StreamState>) -> Result<String, String> {
    if let Some(mut child) = state.active_streams.lock().unwrap().remove(&target_id) {
        let _ = child.kill();
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let dir = get_vault_path().join("hls_cache").join(&target_id);
        if dir.exists() { let _ = std::fs::remove_dir_all(dir); }
        Ok("Stopped".into())
    } else { Ok("Inactive".into()) }
}

#[tauri::command]
async fn geocode_address(address: String) -> Result<(f64, f64), String> {
    let client = reqwest::Client::builder().user_agent("Nemesis/1.0").build().unwrap();
    let url = format!("https://nominatim.openstreetmap.org/search?q={}&format=json&limit=1", urlencoding::encode(&address));
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let data: Vec<Value> = res.json().await.map_err(|e| e.to_string())?;
    if data.is_empty() { return Err("Empty".into()); }
    let lat = data[0]["lat"].as_str().unwrap().parse::<f64>().unwrap();
    let lon = data[0]["lon"].as_str().unwrap().parse::<f64>().unwrap();
    Ok((lat, lon))
}

#[tauri::command]
fn generate_nvr_channels(_vendor: String, channel_count: u32) -> Result<Vec<serde_json::Value>, String> {
    let mut channels = Vec::new();
    for i in 1..=channel_count {
        channels.push(serde_json::json!({ "id": format!("ch{}", i), "index": i, "name": format!("Camera {}", i) }));
    }
    Ok(channels)
}

fn main() {
    let hls_path = get_vault_path().join("hls_cache");
    let _ = std::fs::create_dir_all(&hls_path);
    let server_path = hls_path.clone();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let cors = warp::cors().allow_any_origin()
                .allow_headers(vec!["Range", "User-Agent", "Content-Type", "Accept"])
                .allow_methods(vec!["GET", "OPTIONS"]);
            warp::serve(warp::fs::dir(server_path).with(cors)).run(([127, 0, 0, 1], 49152)).await;
        });
    });

    tauri::Builder::default()
        .manage(StreamState { active_streams: Mutex::new(HashMap::new()) })
        .invoke_handler(tauri::generate_handler![
            save_target, read_target, get_all_targets, delete_target,
            start_stream, stop_stream, geocode_address, generate_nvr_channels, probe_rtsp_path
        ])
        .run(tauri::generate_context!())
        .expect("Hyperion crash");
}