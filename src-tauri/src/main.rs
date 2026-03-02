#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use tokio::sync::Mutex;
use std::collections::HashMap;
use tauri::State;
use warp::Filter;
use serde_json::Value;
use suppaftp::FtpStream;
use regex::Regex;
mod videodvor_scanner;
use videodvor_scanner::VideodvorScanner;


struct StreamState {
    active_streams: Mutex<HashMap<String, std::process::Child>>,
}

struct VideodvorState {
    scanner: Mutex<videodvor_scanner::VideodvorScanner>,
}

fn get_vault_path() -> PathBuf {
    let path = PathBuf::from(r"D:\Nemesis_Vault\recon_db");
    if !path.exists() { let _ = std::fs::create_dir_all(&path); }
    path
}

fn derive_hardware_key() -> [u8; 32] {
    let hw_id = machine_uid::get().unwrap_or_else(|_| "NEMESIS_ID".to_string());
    let mut hasher = Sha256::new();
    hasher.update(hw_id.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&hasher.finalize());
    key
}

#[tauri::command]
fn save_target(target_id: String, payload: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    let hw_key = derive_hardware_key();
    let cipher = Aes256Gcm::new(&hw_key.into());
    let nonce = Nonce::from_slice(b"nemesis_salt");
    let encrypted_data = cipher.encrypt(nonce, payload.as_bytes()).map_err(|_| "Encryption error".to_string())?;
    db.insert(target_id.as_bytes(), encrypted_data).map_err(|e: sled::Error| e.to_string())?;
    Ok("Saved".into())
}

#[tauri::command]
fn read_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    if let Some(data) = db.get(target_id.as_bytes()).map_err(|e: sled::Error| e.to_string())? {
        let hw_key = derive_hardware_key();
        let cipher = Aes256Gcm::new(&hw_key.into());
        let nonce = Nonce::from_slice(b"nemesis_salt");
        let decrypted = cipher.decrypt(nonce, data.as_ref()).map_err(|_| "Access denied".to_string())?;
        String::from_utf8(decrypted).map_err(|_| "UTF-8 error".to_string())
    } else { Err("Not found".to_string()) }
}

#[tauri::command]
fn get_all_targets() -> Result<Vec<String>, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
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
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    db.remove(target_id.as_bytes()).map_err(|e: sled::Error| e.to_string())?;
    Ok("Deleted".into())
}

#[tauri::command]
async fn probe_rtsp_path(host: String, login: String, pass: String) -> Result<String, String> {
    let signatures = vec!["/Streaming/Channels/101", "/cam/realmonitor?channel=1&subtype=0", "/live/ch1"];
    let ffmpeg = get_vault_path().join("ffmpeg.exe");
    for sig in signatures {
        let url = format!("rtsp://{}:{}@{}/{}", login, pass, host, sig.trim_start_matches('/'));
        let s = Command::new(&ffmpeg).args(["-rtsp_transport", "tcp", "-i", &url, "-t", "0.1", "-f", "null", "-"]).status();
        if let Ok(status) = s { if status.success() { return Ok(sig.to_string()); } }
    }
    Err("Recon failed".into())
}

#[tauri::command]
async fn geocode_address(address: String) -> Result<(f64, f64), String> {
    let encoded = urlencoding::encode(&address);
    let url = format!("https://nominatim.openstreetmap.org/search?q={}&format=json&limit=1", encoded);
    let client = reqwest::Client::builder().user_agent("Nemesis").build().unwrap();
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let data: Vec<Value> = res.json().await.map_err(|e| e.to_string())?;
    if data.is_empty() { return Err("Empty".into()); }
    let lat = data[0]["lat"].as_str().unwrap().parse::<f64>().unwrap();
    let lon = data[0]["lon"].as_str().unwrap().parse::<f64>().unwrap();
    Ok((lat, lon))
}

#[tauri::command]
fn generate_nvr_channels(_vendor: String, channel_count: u32) -> Result<Vec<Value>, String> {
    let mut channels = Vec::new();
    for i in 1..=channel_count {
        channels.push(serde_json::json!({ "id": format!("ch{}", i), "index": i, "name": format!("Cam {}", i) }));
    }
    Ok(channels)
}

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
            "-rtsp_transport", "tcp",
            "-timeout", "5000000",
            "-y",
            "-i", &rtsp_url,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-crf", "28",
            "-an",
            "-f", "hls",
            "-hls_time", "1",
            "-hls_list_size", "3",
            "-hls_flags", "delete_segments+append_list",
            playlist.to_str().unwrap()
        ])
        .spawn()
        .map_err(|e| e.to_string())?;

    state.active_streams.lock().unwrap().insert(target_id, child);
    Ok("Started".into())
}

#[tauri::command]
fn stop_stream(target_id: String, state: State<'_, StreamState>) -> Result<String, String> {
    if let Some(mut child) = state.active_streams.lock().unwrap().remove(&target_id) {
        let _ = child.kill();
        Ok("Stopped".into())
    } else { Ok("Inactive".into()) }
}

#[tauri::command]
async fn search_global_hub(query: String, cookie: String) -> Result<Vec<Value>, String> {
    println!("\n[РАДАР ХАБА] Начинаем поиск по запросу: {}", query);

    let client = reqwest::Client::new();
    let encoded_query = urlencoding::encode(&query);
    let url = format!("https://videodvor.by/stream/check.php?search={}", encoded_query);

    println!("[РАДАР ХАБА] Сформирован URL: {}", url);

    let res = client.get(&url)
        .header("Cookie", cookie)
        .send().await.map_err(|e| {
            println!("[РАДАР ХАБА] Ошибка соединения: {}", e);
            e.to_string()
        })?
        .text().await.map_err(|e| {
            println!("[РАДАР ХАБА] Ошибка чтения текста: {}", e);
            e.to_string()
        })?;

    let preview: String = res.chars().take(300).collect();
    println!("[РАДАР ХАБА] Ответ от сайта (превью): {}...", preview);

    let re = Regex::new(r#"id="(\d+)".*?ip="(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})""#).unwrap();
    let mut results = Vec::new();

    for cap in re.captures_iter(&res) {
        results.push(serde_json::json!({"id": &cap[1], "ip": &cap[2]}));
    }

    println!("[РАДАР ХАБА] Поиск завершен. Найдено целей: {}", results.len());

    Ok(results)
}

#[tauri::command]
fn scan_ftp_archive(ip: String, ftp_host: String, ftp_user: String, ftp_pass: String) -> Result<Vec<String>, String> {
    let mut ftp = FtpStream::connect(format!("{}:21", ftp_host)).map_err(|e| e.to_string())?;
    ftp.login(&ftp_user, &ftp_pass).map_err(|e| e.to_string())?;
    ftp.cwd(&ip).map_err(|_| "No archive".to_string())?;
    let list = ftp.nlst(None).map_err(|e| e.to_string())?;
    let _ = ftp.quit();
    Ok(list)
}

#[tauri::command]
fn download_ftp_file(ip: String, filename: String, ftp_host: String, ftp_user: String, ftp_pass: String) -> Result<String, String> {
    let mut ftp = FtpStream::connect(format!("{}:21", ftp_host)).map_err(|e| e.to_string())?;
    ftp.login(&ftp_user, &ftp_pass).map_err(|e| e.to_string())?;
    ftp.cwd(&ip).map_err(|e| e.to_string())?;
    let data = ftp.retr_as_buffer(&filename).map_err(|e| e.to_string())?;
    let path = get_vault_path().join("archives").join(&ip).join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    std::fs::write(&path, data.into_inner()).map_err(|e| e.to_string())?;
    let _ = ftp.quit();
    Ok("Ok".into())
}

#[tauri::command]
async fn videodvor_login(
    username: String,
    password: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<String, String> {
    let mut scanner = state.scanner.lock().unwrap();
    scanner.login(&username, &password).await?;
    Ok("Logged in".into())
}

#[tauri::command]
async fn videodvor_scrape(
    state: tauri::State<'_, VideodvorState>,
) -> Result<Vec<serde_json::Value>, String> {
    let scanner = state.scanner.lock().unwrap();
    scanner.scrape_all_cameras().await
}

#[tauri::command]
async fn videodvor_list_archive(
    ip: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<Vec<String>, String> {
    let scanner = state.scanner.lock().unwrap();
    scanner.get_archive_files(&ip).await
}

#[tauri::command]
async fn videodvor_download_file(
    ip: String,
    filename: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<String, String> {
    let scanner = state.scanner.lock().unwrap();
    scanner.download_file(&ip, &filename).await?;
    Ok("Download started".into())
}

fn main() {
    let hls_path = get_vault_path().join("hls_cache");
    let _ = std::fs::create_dir_all(&hls_path);
    let server_path = hls_path.clone();
    let videodvor = videodvor_scanner::VideodvorScanner::new();
    let videodvor_state = VideodvorState {
    scanner: Mutex::new(videodvor),
    };

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let cors = warp::cors().allow_any_origin().allow_headers(vec!["Range", "User-Agent", "Content-Type", "Accept"]).allow_methods(vec!["GET", "OPTIONS"]);
            warp::serve(warp::fs::dir(server_path).with(cors)).run(([127, 0, 0, 1], 49152)).await;
        });
    });

    tauri::Builder::default()
        .manage(StreamState { active_streams: Mutex::new(HashMap::new()) })
        .plugin(tauri_plugin_shell::init())
        .manage(videodvor_state)
        .invoke_handler(tauri::generate_handler![
            save_target, read_target, get_all_targets, delete_target,
            start_stream, stop_stream, geocode_address, generate_nvr_channels,
            probe_rtsp_path, search_global_hub, scan_ftp_archive, download_ftp_file,
            videodvor_login, videodvor_scrape, videodvor_list_archive, videodvor_download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}