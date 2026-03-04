#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use chrono::Utc;
use dotenv::dotenv;
use futures_util::StreamExt;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::OpenOptions;
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use suppaftp::FtpStream;
use tauri::State;
use tokio::sync::Mutex;
use tokio::{
    net::TcpStream,
    time::{timeout, Duration},
};
use warp::Filter;

mod videodvor_scanner;

struct StreamState {
    active_streams: std::sync::Mutex<HashMap<String, std::process::Child>>,
}

struct VideodvorState {
    scanner: Mutex<videodvor_scanner::VideodvorScanner>,
}

struct LogState {
    lines: std::sync::Mutex<Vec<String>>,
}

struct DownloadCancelState {
    cancelled_tasks: std::sync::Mutex<HashSet<String>>,
}

fn push_runtime_log(state: &State<'_, LogState>, message: impl Into<String>) {
    let ts = Utc::now().format("%H:%M:%S").to_string();
    let line = format!("[{}] {}", ts, message.into());
    if let Ok(mut logs) = state.lines.lock() {
        logs.push(line);
        if logs.len() > 500 {
            let keep_from = logs.len().saturating_sub(500);
            logs.drain(0..keep_from);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NvrDeviceInfoResult {
    endpoint: String,
    status: String,
    body_preview: String,
}

#[derive(Debug, Serialize)]
struct ProtocolProbeResult {
    protocol: String,
    endpoint: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct RoadmapItem {
    name: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct ImplementationStatus {
    total: usize,
    completed: usize,
    in_progress: usize,
    pending: usize,
    left: usize,
    items: Vec<RoadmapItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IsapiRecordingItem {
    endpoint: String,
    track_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    playback_uri: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnvifRecordingItem {
    endpoint: String,
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveEndpointResult {
    protocol: String,
    endpoint: String,
    method: String,
    status: String,
    status_code: Option<u16>,
}

#[derive(Debug, Serialize)]
struct PortProbeResult {
    port: u16,
    service: String,
    open: bool,
}

fn guess_service(port: u16) -> &'static str {
    match port {
        21 => "ftp/archive",
        22 => "ssh/sftp",
        80 => "http/admin",
        443 => "https/admin",
        554 => "rtsp/video",
        8080 => "http-alt/admin",
        8443 => "https-alt/admin",
        _ => "unknown",
    }
}

fn normalize_host_for_scan(input: &str) -> String {
    input
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("rtsp://")
        .split('/')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn get_vault_path() -> PathBuf {
    let path = PathBuf::from(r"D:\Nemesis_Vault\recon_db");
    if !path.exists() {
        let _ = std::fs::create_dir_all(&path);
    }
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

// --- БАЗА ДАННЫХ ПАУКА ---
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct DeviceRecord {
    id: String,
    ip: String,
    first_seen: i64,
    last_seen: i64,
}

async fn save_device_to_db(device_id: &str, ip: &str) -> Result<(), String> {
    let db = sled::open(get_vault_path().join("devices_db")).map_err(|e| e.to_string())?;
    let key = format!("device:{}", device_id);
    let now = Utc::now().timestamp();
    let record = DeviceRecord {
        id: device_id.to_string(),
        ip: ip.to_string(),
        first_seen: now,
        last_seen: now,
    };
    let value = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    db.insert(key.as_bytes(), value)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --- ИНТЕГРАЦИЯ SHODAN ---
#[tauri::command]
async fn shodan_search(country: String, city: String) -> Result<Vec<Value>, String> {
    let api_key = env::var("SHODAN_API_KEY").unwrap_or_default();
    let client = reqwest::Client::new();
    let query = format!("webcam port:80,554 country:{} city:{}", country, city);
    let url = format!(
        "https://api.shodan.io/shodan/host/search?key={}&query={}",
        api_key,
        urlencoding::encode(&query)
    );

    let res: Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    if let Some(matches) = res["matches"].as_array() {
        for m in matches {
            let ip = m["ip_str"].as_str().unwrap_or("").to_string();
            let port = m["port"].as_u64().unwrap_or(0);
            let dev_id = format!("shodan_{}", ip.replace(".", "_"));
            let _ = save_device_to_db(&dev_id, &ip).await;
            results.push(serde_json::json!({"id": dev_id, "ip": format!("{}:{}", ip, port), "status": "Обнаружено (Shodan)"}));
        }
    }
    Ok(results)
}

// --- НОВЫЙ МОДУЛЬ: FFMPEG ТУННЕЛЬ ДЛЯ ХАБА ---
#[tauri::command]
fn start_hub_stream(
    target_id: String,
    user_id: String,
    channel_id: String,
    cookie: String,
    state: State<'_, StreamState>,
) -> Result<String, String> {
    let cache = get_vault_path().join("hls_cache").join(&target_id);
    let _ = std::fs::create_dir_all(&cache);
    let playlist = cache.join("stream.m3u8");

    {
        let mut streams = state.active_streams.lock().unwrap();
        if let Some(mut old) = streams.remove(&target_id) {
            let _ = old.kill();
        }
    }

    let url = format!(
        "https://videodvor.by/stream/rtsp2mjpeg.php?get=1&user=user{}&id={}",
        user_id, channel_id
    );

    // ВАЖНО: FFmpeg требует строгих переносов \r\n.
    // И мы добавляем Referer: admin.php, чтобы обмануть защиту Хаба!
    let headers = format!(
        "Cookie: {}\r\nReferer: https://videodvor.by/stream/admin.php\r\n",
        cookie
    );

    let child = Command::new(get_vault_path().join("ffmpeg.exe"))
        .args([
            "-headers",
            &headers,
            "-user_agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
            "-probesize",
            "10000000",
            "-analyzeduration",
            "10000000",
            "-use_wallclock_as_timestamps",
            "1",
            "-f",
            "mpjpeg",
            "-y",
            "-i",
            &url,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-crf",
            "28",
            "-an",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_list_size",
            "3",
            "-hls_flags",
            "delete_segments+append_list",
            playlist.to_str().unwrap(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;

    state
        .active_streams
        .lock()
        .unwrap()
        .insert(target_id, child);
    Ok("Started".into())
}

// --- ИСПРАВЛЕННЫЙ СКАНЕР: НАХОДИТ ВСЕ КАНАЛЫ (КАМЕРЫ) ---
#[tauri::command]
async fn search_global_hub(query: String, cookie: String) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    let encoded_query = urlencoding::encode(&query);
    let url = format!(
        "https://videodvor.by/stream/check.php?search={}",
        encoded_query
    );

    let res = client
        .get(&url)
        .header("Cookie", cookie)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    let blocks: Vec<&str> = res.split("<div class=\"name-blok\">").collect();

    let re_user = Regex::new(r#"<b>USER\s*(\d+)</b>\s*\((.*?)\)</div>"#).unwrap();
    let re_channels = Regex::new(r#"id=(\d+)""#).unwrap();

    for block in blocks.iter().skip(1) {
        if let Some(caps) = re_user.captures(block) {
            let user_id = caps[1].to_string();
            let address = caps[2].to_string();

            let mut channels = Vec::new();
            for ch_caps in re_channels.captures_iter(block) {
                channels.push(ch_caps[1].to_string());
            }
            if channels.is_empty() {
                channels.push("0".to_string());
            }

            results.push(serde_json::json!({
                "id": user_id,
                "ip": address,
                "channels": channels
            }));
        }
    }
    Ok(results)
}

fn start_background_scheduler() {
    std::thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
            }
        });
    });
}

#[tauri::command]
fn save_target(target_id: String, payload: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault"))
        .map_err(|e: sled::Error| e.to_string())?;
    let cipher = Aes256Gcm::new(&derive_hardware_key().into());
    let encrypted_data = cipher
        .encrypt(Nonce::from_slice(b"nemesis_salt"), payload.as_bytes())
        .map_err(|_| "Encryption error".to_string())?;
    db.insert(target_id.as_bytes(), encrypted_data)
        .map_err(|e: sled::Error| e.to_string())?;
    Ok("Saved".into())
}

#[tauri::command]
fn read_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault"))
        .map_err(|e: sled::Error| e.to_string())?;
    if let Some(data) = db
        .get(target_id.as_bytes())
        .map_err(|e: sled::Error| e.to_string())?
    {
        let cipher = Aes256Gcm::new(&derive_hardware_key().into());
        let decrypted = cipher
            .decrypt(Nonce::from_slice(b"nemesis_salt"), data.as_ref())
            .map_err(|_| "Access denied".to_string())?;
        String::from_utf8(decrypted).map_err(|_| "UTF-8 error".to_string())
    } else {
        Err("Not found".to_string())
    }
}

#[tauri::command]
fn get_all_targets() -> Result<Vec<String>, String> {
    let db = sled::open(get_vault_path().join("targets_vault"))
        .map_err(|e: sled::Error| e.to_string())?;
    let mut keys = Vec::new();
    for k in db.iter().keys() {
        if let Ok(key_bytes) = k {
            if let Ok(s) = String::from_utf8(key_bytes.to_vec()) {
                keys.push(s);
            }
        }
    }
    Ok(keys)
}

#[tauri::command]
fn delete_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault"))
        .map_err(|e: sled::Error| e.to_string())?;
    db.remove(target_id.as_bytes())
        .map_err(|e: sled::Error| e.to_string())?;
    Ok("Deleted".into())
}

#[tauri::command]
async fn probe_rtsp_path(host: String, login: String, pass: String) -> Result<String, String> {
    let signatures = vec![
        "/Streaming/Channels/101",
        "/cam/realmonitor?channel=1&subtype=0",
        "/live/ch1",
    ];
    let ffmpeg = get_vault_path().join("ffmpeg.exe");
    for sig in signatures {
        let url = format!(
            "rtsp://{}:{}@{}/{}",
            login,
            pass,
            host,
            sig.trim_start_matches('/')
        );
        let s = Command::new(&ffmpeg)
            .args([
                "-rtsp_transport",
                "tcp",
                "-i",
                &url,
                "-t",
                "0.1",
                "-f",
                "null",
                "-",
            ])
            .status();
        if let Ok(status) = s {
            if status.success() {
                return Ok(sig.to_string());
            }
        }
    }
    Err("Recon failed".into())
}

#[tauri::command]
async fn geocode_address(address: String) -> Result<(f64, f64), String> {
    let encoded = urlencoding::encode(&address);
    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=json&limit=1",
        encoded
    );
    let client = reqwest::Client::builder()
        .user_agent("Nemesis")
        .build()
        .unwrap();
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let data: Vec<Value> = res.json().await.map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Err("Empty".into());
    }
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
fn start_stream(
    target_id: String,
    rtsp_url: String,
    state: State<'_, StreamState>,
    log_state: State<'_, LogState>,
) -> Result<String, String> {
    push_runtime_log(&log_state, format!("Start stream: {}", target_id));
    let cache = get_vault_path().join("hls_cache").join(&target_id);
    let _ = std::fs::create_dir_all(&cache);
    let playlist = cache.join("stream.m3u8");
    {
        let mut streams = state.active_streams.lock().unwrap();
        if let Some(mut old) = streams.remove(&target_id) {
            let _ = old.kill();
        }
    }
    let child = Command::new(get_vault_path().join("ffmpeg.exe"))
        .args([
            "-rtsp_transport",
            "tcp",
            "-timeout",
            "5000000",
            "-y",
            "-i",
            &rtsp_url,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-crf",
            "28",
            "-an",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_list_size",
            "3",
            "-hls_flags",
            "delete_segments+append_list",
            playlist.to_str().unwrap(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;
    state
        .active_streams
        .lock()
        .unwrap()
        .insert(target_id, child);
    Ok("Started".into())
}

#[tauri::command]
fn stop_stream(
    target_id: String,
    state: State<'_, StreamState>,
    log_state: State<'_, LogState>,
) -> Result<String, String> {
    if let Some(mut child) = state.active_streams.lock().unwrap().remove(&target_id) {
        let _ = child.kill();
        push_runtime_log(&log_state, format!("Stop stream: {}", target_id));
        Ok("Stopped".into())
    } else {
        Ok("Inactive".into())
    }
}

// --- НОВЫЙ БЛОК FTP-НАВИГАТОРА ---

#[derive(Serialize)]
pub struct FtpFolder {
    pub name: String,
    pub path: String,
}

struct FtpConfig {
    host: &'static str,
    user: &'static str,
    pass: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadReport {
    server_alias: String,
    filename: String,
    save_path: String,
    bytes_written: u64,
    total_bytes: u64,
    duration_ms: u128,
    resumed: bool,
    skipped_as_complete: bool,
}

fn sanitize_filename_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "recording".into()
    } else {
        trimmed.to_string()
    }
}

fn resolve_ftp_config(server_alias: &str) -> Result<FtpConfig, String> {
    match server_alias {
        "video1" => Ok(FtpConfig {
            host: "93.125.48.66:21",
            user: "mvd",
            pass: "gpfZrw%9RVqp",
        }),
        "video2" => Ok(FtpConfig {
            host: "93.125.48.100:21",
            user: "mvd",
            pass: "gpfZrw%9RVqp",
        }),
        _ => Err(format!("Неизвестный сервер: {}", server_alias)),
    }
}

fn resolve_socket_addrs(host: &str) -> Result<Vec<std::net::SocketAddr>, String> {
    host.to_socket_addrs()
        .map(|iter| iter.collect::<Vec<_>>())
        .map_err(|e| format!("Не удалось резолвить FTP хост {}: {}", host, e))
        .and_then(|addrs| {
            if addrs.is_empty() {
                Err(format!("FTP хост {} не вернул ни одного адреса", host))
            } else {
                Ok(addrs)
            }
        })
}

fn ftp_banner_probe(host: &str, attempts: usize) -> Result<String, String> {
    let mut last_err = String::from("FTP preflight не выполнился");

    let addrs = resolve_socket_addrs(host).ok();

    for attempt in 1..=attempts {
        println!(
            "[FTP PREFLIGHT] попытка {}/{} -> {}",
            attempt, attempts, host
        );

        let mut connected = false;

        if let Some(addrs) = &addrs {
            for connect_addr in addrs {
                match std::net::TcpStream::connect_timeout(
                    connect_addr,
                    std::time::Duration::from_secs(3),
                ) {
                    Ok(mut stream) => {
                        connected = true;
                        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));

                        let mut buf = [0u8; 512];
                        match std::io::Read::read(&mut stream, &mut buf) {
                            Ok(n) if n > 0 => {
                                let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                                println!("[FTP PREFLIGHT] banner: {}", banner);
                                return Ok(banner);
                            }
                            Ok(_) => {
                                let _ = std::io::Write::write_all(&mut stream, b"NOOP\r\n");
                                match std::io::Read::read(&mut stream, &mut buf) {
                                    Ok(n2) if n2 > 0 => {
                                        let banner =
                                            String::from_utf8_lossy(&buf[..n2]).trim().to_string();
                                        println!("[FTP PREFLIGHT] late banner: {}", banner);
                                        return Ok(banner);
                                    }
                                    _ => {
                                        last_err =
                                            format!("Пустой ответ баннера FTP от {}", connect_addr);
                                    }
                                }
                            }
                            Err(e) => {
                                last_err =
                                    format!("Ошибка чтения баннера FTP от {}: {}", connect_addr, e);
                            }
                        }
                    }
                    Err(e) => {
                        last_err = format!("Ошибка TCP подключения к FTP {}: {}", connect_addr, e);
                    }
                }
            }
        }

        if !connected {
            match std::net::TcpStream::connect(host) {
                Ok(mut stream) => {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut buf = [0u8; 512];
                    match std::io::Read::read(&mut stream, &mut buf) {
                        Ok(n) if n > 0 => {
                            let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                            println!("[FTP PREFLIGHT] direct banner: {}", banner);
                            return Ok(banner);
                        }
                        _ => {
                            last_err = format!("Пустой/невалидный прямой banner для {}", host);
                        }
                    }
                }
                Err(e) => {
                    last_err = format!("Ошибка прямого TCP подключения к FTP {}: {}", host, e);
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(350));
    }

    Err(last_err)
}

fn ftp_connect_with_retry(
    host: &str,
    user: &str,
    pass: &str,
    attempts: usize,
) -> Result<FtpStream, String> {
    let mut last_err = String::from("FTP connect не выполнился");
    let addrs = resolve_socket_addrs(host).ok();

    for attempt in 1..=attempts {
        println!("[FTP CONNECT] попытка {}/{} -> {}", attempt, attempts, host);

        let mut attempted = false;
        if let Some(addrs) = &addrs {
            for addr in addrs {
                attempted = true;
                match FtpStream::connect(addr.to_string()) {
                    Ok(mut ftp) => {
                        ftp.set_mode(suppaftp::Mode::Passive);
                        match ftp.login(user, pass) {
                            Ok(_) => return Ok(ftp),
                            Err(e) => {
                                last_err = format!("Ошибка FTP login для {}: {}", addr, e);
                                let _ = ftp.quit();
                            }
                        }
                    }
                    Err(e) => {
                        last_err = format!("Ошибка FTP connect к {}: {}", addr, e);
                    }
                }
            }
        }

        if !attempted {
            match FtpStream::connect(host) {
                Ok(mut ftp) => {
                    ftp.set_mode(suppaftp::Mode::Passive);
                    match ftp.login(user, pass) {
                        Ok(_) => return Ok(ftp),
                        Err(e) => {
                            last_err = format!("Ошибка FTP login для {}: {}", host, e);
                            let _ = ftp.quit();
                        }
                    }
                }
                Err(e) => {
                    last_err = format!("Ошибка FTP connect к {}: {}", host, e);
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(350));
    }

    Err(last_err)
}

fn ftp_nlst_root_with_fallback(ftp: &mut FtpStream) -> Result<Vec<String>, String> {
    let mut last_err = String::new();

    for candidate in [Some("/"), Some("."), None] {
        match ftp.nlst(candidate) {
            Ok(items) if !items.is_empty() => return Ok(items),
            Ok(_) => {
                last_err = format!("FTP nlst вернул пустой список для {:?}", candidate);
            }
            Err(e) => {
                last_err = format!("FTP nlst ошибка для {:?}: {}", candidate, e);
            }
        }
    }

    match ftp.list(Some("/")) {
        Ok(lines) if !lines.is_empty() => {
            let mut items = Vec::new();
            for line in lines {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let name = trimmed
                    .split_whitespace()
                    .last()
                    .map(|s| s.trim().trim_start_matches('/').to_string())
                    .unwrap_or_default();
                if !name.is_empty() {
                    items.push(name);
                }
            }
            if !items.is_empty() {
                return Ok(items);
            }
            last_err = "FTP list fallback вернул пустой список".into();
        }
        Ok(_) => {
            last_err = "FTP list fallback вернул пустой ответ".into();
        }
        Err(e) => {
            last_err = format!("FTP list fallback ошибка: {}", e);
        }
    }

    Err(last_err)
}

#[tauri::command]
fn get_ftp_folders(
    server_alias: &str,
    log_state: State<'_, LogState>,
) -> Result<Vec<FtpFolder>, String> {
    push_runtime_log(
        &log_state,
        format!("FTP list requested for server {}", server_alias),
    );

    let cfg = resolve_ftp_config(server_alias)?;

    let _banner = ftp_banner_probe(cfg.host, 3)?;
    let mut ftp = ftp_connect_with_retry(cfg.host, cfg.user, cfg.pass, 3)?;

    let list = ftp_nlst_root_with_fallback(&mut ftp)?;

    let mut folders = Vec::new();
    for item in list {
        let name = item.trim_start_matches('/').to_string();
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }

        folders.push(FtpFolder {
            name: name.clone(),
            path: format!("/{}", name),
        });
    }

    let _ = ftp.quit();
    push_runtime_log(
        &log_state,
        format!(
            "FTP list completed for server {} ({} entries)",
            server_alias,
            folders.len()
        ),
    );
    Ok(folders)
}

#[tauri::command]
fn download_ftp_file(
    server_alias: &str,
    folder_path: String,
    filename: String,
    resume_if_exists: Option<bool>,
    task_id: Option<String>,
    log_state: State<'_, LogState>,
    cancel_state: State<'_, DownloadCancelState>,
) -> Result<DownloadReport, String> {
    let task_key = task_id.unwrap_or_else(|| {
        format!(
            "{}_{}_{}",
            server_alias,
            filename,
            Utc::now().timestamp_millis()
        )
    });
    push_runtime_log(
        &log_state,
        format!(
            "FTP download requested: {} from {} [task:{}]",
            filename, server_alias, task_key
        ),
    );

    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    let cfg = resolve_ftp_config(server_alias)?;

    let _banner = ftp_banner_probe(cfg.host, 3)?;
    let mut ftp = ftp_connect_with_retry(cfg.host, cfg.user, cfg.pass, 3)?;

    let normalized_folder = folder_path.trim().trim_matches('/').to_string();
    let mut retr_candidates = vec![filename.clone()];
    if !normalized_folder.is_empty() {
        retr_candidates.push(format!("{}/{}", normalized_folder, filename));
        retr_candidates.push(format!("/{}/{}", normalized_folder, filename));
        retr_candidates.push(format!("./{}/{}", normalized_folder, filename));
    }
    retr_candidates.sort();
    retr_candidates.dedup();

    if folder_path != "/" && !folder_path.is_empty() {
        if let Err(e) = ftp.cwd(&folder_path) {
            push_runtime_log(
                &log_state,
                format!(
                    "FTP cwd failed for '{}' ({}), switching to low-level RETR path fallbacks",
                    folder_path, e
                ),
            );
        }
    }

    let path = get_vault_path()
        .join("archives")
        .join(server_alias)
        .join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());

    let resume = resume_if_exists.unwrap_or(true);
    let local_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut remote_size = 0u64;
    for candidate in &retr_candidates {
        if let Ok(sz) = ftp.size(candidate) {
            remote_size = sz as u64;
            break;
        }
    }

    if resume && local_size > 0 && remote_size > 0 && local_size >= remote_size {
        push_runtime_log(
            &log_state,
            format!(
                "FTP skip: {} already complete ({} bytes)",
                filename, local_size
            ),
        );

        let _ = ftp.quit();
        return Ok(DownloadReport {
            server_alias: server_alias.to_string(),
            filename,
            save_path: path.to_string_lossy().to_string(),
            bytes_written: 0,
            total_bytes: local_size,
            duration_ms: 0,
            resumed: false,
            skipped_as_complete: true,
        });
    }

    let started = std::time::Instant::now();
    let mut resumed = false;

    if resume && local_size > 0 {
        if ftp.resume_transfer(local_size as usize).is_ok() {
            resumed = true;
            push_runtime_log(
                &log_state,
                format!(
                    "FTP resume enabled for {} from offset {}",
                    filename, local_size
                ),
            );
        } else {
            push_runtime_log(
                &log_state,
                format!(
                    "FTP resume rejected for {}, fallback to full download",
                    filename
                ),
            );
        }
    }

    let mut retr_path_used = String::new();
    let mut last_retr_err = String::new();
    let mut data_stream_opt = None;
    for candidate in &retr_candidates {
        match ftp.retr_as_stream(candidate) {
            Ok(stream) => {
                retr_path_used = candidate.clone();
                data_stream_opt = Some(stream);
                break;
            }
            Err(e) => {
                last_retr_err = format!("{} => {}", candidate, e);
            }
        }
    }

    let mut resumed_downgraded = false;
    if data_stream_opt.is_none() && resumed {
        push_runtime_log(
            &log_state,
            format!(
                "FTP resume stream setup failed for {} ({}), reconnecting without resume",
                filename, last_retr_err
            ),
        );
        let _ = ftp.quit();
        ftp = ftp_connect_with_retry(cfg.host, cfg.user, cfg.pass, 2)?;
        if folder_path != "/" && !folder_path.is_empty() {
            let _ = ftp.cwd(&folder_path);
        }

        for candidate in &retr_candidates {
            match ftp.retr_as_stream(candidate) {
                Ok(stream) => {
                    retr_path_used = candidate.clone();
                    data_stream_opt = Some(stream);
                    resumed_downgraded = true;
                    break;
                }
                Err(e) => {
                    last_retr_err = format!("{} => {}", candidate, e);
                }
            }
        }
    }

    let mut data_stream = data_stream_opt
        .ok_or_else(|| format!("FTP RETR failed for all path candidates: {}", last_retr_err))?;

    if resumed_downgraded {
        resumed = false;
        push_runtime_log(
            &log_state,
            format!(
                "FTP resume degraded to full download for {} (path: {})",
                filename, retr_path_used
            ),
        );
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resumed)
        .append(resumed)
        .open(&path)
        .map_err(|e| e.to_string())?;

    let mut bytes_written: u64 = 0;
    let mut chunk = [0u8; 64 * 1024];
    let progress_step = 2 * 1024 * 1024u64;
    let mut next_progress_mark = progress_step;

    loop {
        let n = std::io::Read::read(&mut data_stream, &mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if cancel_state
            .cancelled_tasks
            .lock()
            .map(|set| set.contains(&task_key))
            .unwrap_or(false)
        {
            let _ = ftp.quit();
            if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
                cancelled.remove(&task_key);
            }
            push_runtime_log(
                &log_state,
                format!("DOWNLOAD_CANCELLED|{}|{}", task_key, filename),
            );
            return Err(format!(
                "Загрузка отменена пользователем [task:{}]",
                task_key
            ));
        }

        std::io::Write::write_all(&mut file, &chunk[..n]).map_err(|e| e.to_string())?;
        bytes_written += n as u64;

        let current_total = local_size + bytes_written;
        if current_total >= next_progress_mark {
            push_runtime_log(
                &log_state,
                format!(
                    "DOWNLOAD_PROGRESS|{}|{}|{}",
                    task_key,
                    current_total,
                    remote_size.max(current_total)
                ),
            );
            next_progress_mark += progress_step;
        }
    }

    if let Err(e) = ftp.finalize_retr_stream(data_stream) {
        let msg = e.to_string();
        let soft_ok = msg.contains("226") || msg.contains("425") || msg.contains("timed out");
        if soft_ok {
            push_runtime_log(
                &log_state,
                format!("FTP finalize warning ignored for {}: {}", filename, msg),
            );
        } else {
            return Err(msg);
        }
    }

    let _ = ftp.quit();
    let duration_ms = started.elapsed().as_millis();
    let total_bytes = if resumed {
        local_size + bytes_written
    } else {
        bytes_written
    };

    push_runtime_log(
        &log_state,
        format!(
            "FTP download finished: {} from {} via {} (written {} bytes, total {} bytes, {} ms) [task:{}]",
            filename, server_alias, retr_path_used, bytes_written, total_bytes, duration_ms, task_key
        ),
    );

    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    Ok(DownloadReport {
        server_alias: server_alias.to_string(),
        filename,
        save_path: path.to_string_lossy().to_string(),
        bytes_written,
        total_bytes,
        duration_ms,
        resumed,
        skipped_as_complete: false,
    })
}

#[tauri::command]
fn cancel_download_task(
    task_id: String,
    cancel_state: State<'_, DownloadCancelState>,
    log_state: State<'_, LogState>,
) -> Result<String, String> {
    let mut cancelled = cancel_state
        .cancelled_tasks
        .lock()
        .map_err(|_| "Failed to access cancel state".to_string())?;
    cancelled.insert(task_id.clone());
    push_runtime_log(
        &log_state,
        format!("Download cancel requested [task:{}]", task_id),
    );
    Ok("cancel_requested".into())
}

#[tauri::command]
fn get_runtime_logs(
    limit: Option<usize>,
    state: State<'_, LogState>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(100).min(500);
    let logs = state
        .lines
        .lock()
        .map_err(|_| "Failed to access runtime logs".to_string())?;

    let start = logs.len().saturating_sub(limit);
    Ok(logs[start..].to_vec())
}

#[tauri::command]
async fn videodvor_login(
    username: String,
    password: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<String, String> {
    let mut scanner = state.scanner.lock().await;
    scanner.login(&username, &password).await?;
    Ok("Logged in".into())
}

#[tauri::command]
async fn videodvor_scrape(
    state: tauri::State<'_, VideodvorState>,
) -> Result<Vec<serde_json::Value>, String> {
    let scanner = state.scanner.lock().await;
    scanner.scrape_all_cameras().await
}

#[tauri::command]
async fn videodvor_list_archive(
    ip: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<Vec<String>, String> {
    let scanner = state.scanner.lock().await;
    scanner.get_archive_files(&ip).await
}

#[tauri::command]
async fn videodvor_download_file(
    ip: String,
    filename: String,
    state: tauri::State<'_, VideodvorState>,
) -> Result<String, String> {
    let scanner = state.scanner.lock().await;
    scanner.download_file(&ip, &filename).await?;
    Ok("Download started".into())
}

// --- ФУНКЦИИ ДЛЯ СОВМЕСТИМОСТИ С videodvor_scanner.rs ---

pub fn scan_ftp_archive(
    ip: String,
    ftp_host: String,
    ftp_user: String,
    ftp_pass: String,
) -> Result<Vec<String>, String> {
    let host = format!("{}:21", ftp_host);
    let _ = ftp_banner_probe(&host, 2);
    let mut ftp = ftp_connect_with_retry(&host, &ftp_user, &ftp_pass, 2)?;

    if ip != "/" && !ip.is_empty() {
        let _ = ftp.cwd(&ip);
    }
    let list = ftp_nlst_root_with_fallback(&mut ftp)?;
    let _ = ftp.quit();
    Ok(list)
}

pub fn download_ftp_scanner(
    ip: String,
    filename: String,
    ftp_host: String,
    ftp_user: String,
    ftp_pass: String,
) -> Result<String, String> {
    let host = format!("{}:21", ftp_host);
    let _ = ftp_banner_probe(&host, 2);
    let mut ftp = ftp_connect_with_retry(&host, &ftp_user, &ftp_pass, 2)?;

    let _ = ftp.cwd(&ip);
    let data = ftp.retr_as_buffer(&filename).map_err(|e| e.to_string())?;

    // Путь сохранения для сканера
    let path = get_vault_path().join("archives").join(&ip).join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    std::fs::write(&path, data.into_inner()).map_err(|e| e.to_string())?;

    let _ = ftp.quit();
    Ok("Ok".into())
}

#[tauri::command]
async fn probe_nvr_protocols(
    host: String,
    login: String,
    pass: String,
    log_state: State<'_, LogState>,
) -> Result<Vec<ProtocolProbeResult>, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для проверки протоколов".into());
    }

    push_runtime_log(
        &log_state,
        format!("Protocol probe started for {}", clean_host),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    let onvif_endpoints = vec![
        format!("http://{}:80/onvif/device_service", clean_host),
        format!("http://{}:8080/onvif/device_service", clean_host),
        format!("https://{}:443/onvif/device_service", clean_host),
        format!("https://{}:8443/onvif/device_service", clean_host),
    ];

    for endpoint in onvif_endpoints {
        let status = match client.get(&endpoint).send().await {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 401 => "detected",
            Ok(_) => "not_detected",
            Err(_) => "unreachable",
        };
        out.push(ProtocolProbeResult {
            protocol: "ONVIF".into(),
            endpoint,
            status: status.into(),
        });
    }

    let isapi_endpoints = vec![
        format!("http://{}:80/ISAPI/System/deviceInfo", clean_host),
        format!("http://{}:8080/ISAPI/System/deviceInfo", clean_host),
        format!("https://{}:443/ISAPI/System/deviceInfo", clean_host),
        format!("https://{}:8443/ISAPI/System/deviceInfo", clean_host),
    ];

    for endpoint in isapi_endpoints {
        let status = match client
            .get(&endpoint)
            .basic_auth(login.clone(), Some(pass.clone()))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 401 => "detected",
            Ok(_) => "not_detected",
            Err(_) => "unreachable",
        };
        out.push(ProtocolProbeResult {
            protocol: "ISAPI".into(),
            endpoint,
            status: status.into(),
        });
    }

    let detected = out.iter().filter(|x| x.status == "detected").count();
    push_runtime_log(
        &log_state,
        format!(
            "Protocol probe finished for {} (detected: {})",
            clean_host, detected
        ),
    );
    Ok(out)
}

#[tauri::command]
async fn fetch_nvr_device_info(
    host: String,
    login: String,
    pass: String,
    log_state: State<'_, LogState>,
) -> Result<NvrDeviceInfoResult, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для ISAPI deviceInfo".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let candidates = vec![
        format!("http://{}:80/ISAPI/System/deviceInfo", clean_host),
        format!("http://{}:8080/ISAPI/System/deviceInfo", clean_host),
        format!("https://{}:443/ISAPI/System/deviceInfo", clean_host),
        format!("https://{}:8443/ISAPI/System/deviceInfo", clean_host),
    ];

    push_runtime_log(
        &log_state,
        format!("ISAPI deviceInfo fetch started for {}", clean_host),
    );

    for endpoint in candidates {
        let resp = client
            .get(&endpoint)
            .basic_auth(login.clone(), Some(pass.clone()))
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status_code = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                if status_code == 200 || status_code == 401 {
                    let preview = text.chars().take(600).collect::<String>();
                    push_runtime_log(
                        &log_state,
                        format!(
                            "ISAPI deviceInfo response {} from {}",
                            status_code, endpoint
                        ),
                    );
                    return Ok(NvrDeviceInfoResult {
                        endpoint,
                        status: status_code.to_string(),
                        body_preview: preview,
                    });
                }
            }
            Err(_) => {}
        }
    }

    push_runtime_log(
        &log_state,
        format!("ISAPI deviceInfo unavailable for {}", clean_host),
    );

    Err("ISAPI deviceInfo endpoint не найден или недоступен".into())
}

#[tauri::command]
async fn fetch_onvif_device_info(
    host: String,
    login: String,
    pass: String,
    log_state: State<'_, LogState>,
) -> Result<NvrDeviceInfoResult, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для ONVIF device info".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let candidates = vec![
        format!("http://{}:80/onvif/device_service", clean_host),
        format!("http://{}:8080/onvif/device_service", clean_host),
        format!("https://{}:443/onvif/device_service", clean_host),
        format!("https://{}:8443/onvif/device_service", clean_host),
    ];

    let soap = r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Body>
    <tds:GetDeviceInformation/>
  </s:Body>
</s:Envelope>"#;

    push_runtime_log(
        &log_state,
        format!("ONVIF device info fetch started for {}", clean_host),
    );

    for endpoint in candidates {
        let resp = client
            .post(&endpoint)
            .header("Content-Type", "application/soap+xml; charset=utf-8")
            .basic_auth(login.clone(), Some(pass.clone()))
            .body(soap.to_string())
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status_code = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                if status_code == 200 || status_code == 401 {
                    let preview = text.chars().take(600).collect::<String>();
                    push_runtime_log(
                        &log_state,
                        format!(
                            "ONVIF device info response {} from {}",
                            status_code, endpoint
                        ),
                    );
                    return Ok(NvrDeviceInfoResult {
                        endpoint,
                        status: status_code.to_string(),
                        body_preview: preview,
                    });
                }
            }
            Err(_) => {}
        }
    }

    push_runtime_log(
        &log_state,
        format!("ONVIF device info unavailable for {}", clean_host),
    );

    Err("ONVIF device_service недоступен или не поддерживает GetDeviceInformation".into())
}

#[tauri::command]
async fn search_isapi_recordings(
    host: String,
    login: String,
    pass: String,
    from_time: Option<String>,
    to_time: Option<String>,
    log_state: State<'_, LogState>,
) -> Result<Vec<IsapiRecordingItem>, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для ISAPI search".into());
    }

    let from = from_time.unwrap_or_else(|| "2026-01-01T00:00:00Z".into());
    let to = to_time.unwrap_or_else(|| "2026-12-31T23:59:59Z".into());

    let body = format!(
        "<?xml version="1.0" encoding="UTF-8"?>
<SearchDescription>
  <searchID>1</searchID>
  <trackList><trackID>101</trackID></trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>{}</startTime>
      <endTime>{}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>40</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</SearchDescription>",
        from, to
    );

    let candidates = vec![
        format!("http://{}:80/ISAPI/ContentMgmt/search", clean_host),
        format!("http://{}:8080/ISAPI/ContentMgmt/search", clean_host),
        format!("https://{}:443/ISAPI/ContentMgmt/search", clean_host),
        format!("https://{}:8443/ISAPI/ContentMgmt/search", clean_host),
    ];

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    push_runtime_log(
        &log_state,
        format!(
            "ISAPI search started for {} [{} - {}]",
            clean_host, from, to
        ),
    );

    let start_re = Regex::new(r"<startTime>([^<]+)</startTime>").map_err(|e| e.to_string())?;
    let end_re = Regex::new(r"<endTime>([^<]+)</endTime>").map_err(|e| e.to_string())?;
    let track_re = Regex::new(r"<trackID>([^<]+)</trackID>").map_err(|e| e.to_string())?;
    let uri_re = Regex::new(r"<playbackURI>([^<]+)</playbackURI>").map_err(|e| e.to_string())?;

    for endpoint in candidates {
        let resp = client
            .post(&endpoint)
            .header("Content-Type", "application/xml")
            .basic_auth(login.clone(), Some(pass.clone()))
            .body(body.clone())
            .send()
            .await;

        match resp {
            Ok(r) => {
                let code = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                if code != 200 {
                    continue;
                }

                let starts: Vec<String> = start_re
                    .captures_iter(&text)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .collect();
                let ends: Vec<String> = end_re
                    .captures_iter(&text)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .collect();
                let tracks: Vec<String> = track_re
                    .captures_iter(&text)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .collect();
                let uris: Vec<String> = uri_re
                    .captures_iter(&text)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .collect();

                let count = [starts.len(), ends.len(), tracks.len(), uris.len()]
                    .into_iter()
                    .max()
                    .unwrap_or(0)
                    .min(40);
                let mut items = Vec::with_capacity(count.max(1));

                if count == 0 {
                    items.push(IsapiRecordingItem {
                        endpoint: endpoint.clone(),
                        track_id: None,
                        start_time: None,
                        end_time: None,
                        playback_uri: None,
                    });
                } else {
                    for i in 0..count {
                        items.push(IsapiRecordingItem {
                            endpoint: endpoint.clone(),
                            track_id: tracks.get(i).cloned(),
                            start_time: starts.get(i).cloned(),
                            end_time: ends.get(i).cloned(),
                            playback_uri: uris.get(i).cloned(),
                        });
                    }
                }

                push_runtime_log(
                    &log_state,
                    format!(
                        "ISAPI search finished for {} via {} (items: {})",
                        clean_host,
                        endpoint,
                        items.len()
                    ),
                );
                return Ok(items);
            }
            Err(_) => continue,
        }
    }

    push_runtime_log(
        &log_state,
        format!("ISAPI search unavailable for {}", clean_host),
    );
    Err("ISAPI ContentMgmt/search недоступен или вернул неподдерживаемый ответ".into())
}

#[tauri::command]
async fn search_onvif_recordings(
    host: String,
    login: String,
    pass: String,
    log_state: State<'_, LogState>,
) -> Result<Vec<OnvifRecordingItem>, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для ONVIF recordings search".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let endpoints = vec![
        format!("http://{}:80/onvif/recording_service", clean_host),
        format!("http://{}:8080/onvif/recording_service", clean_host),
        format!("https://{}:443/onvif/recording_service", clean_host),
        format!("https://{}:8443/onvif/recording_service", clean_host),
    ];

    let soap = r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl">
  <s:Body>
    <trc:GetRecordings/>
  </s:Body>
</s:Envelope>"#;

    let token_re =
        Regex::new(r"<[^>]*RecordingToken[^>]*>([^<]+)</[^>]+>").map_err(|e| e.to_string())?;

    push_runtime_log(
        &log_state,
        format!("ONVIF recordings search started for {}", clean_host),
    );

    for endpoint in endpoints {
        let resp = client
            .post(&endpoint)
            .header("Content-Type", "application/soap+xml; charset=utf-8")
            .basic_auth(login.clone(), Some(pass.clone()))
            .body(soap.to_string())
            .send()
            .await;

        match resp {
            Ok(r) => {
                if !r.status().is_success() && r.status().as_u16() != 401 {
                    continue;
                }
                let text = r.text().await.unwrap_or_default();
                let mut out = Vec::new();
                for cap in token_re.captures_iter(&text) {
                    if let Some(m) = cap.get(1) {
                        out.push(OnvifRecordingItem {
                            endpoint: endpoint.clone(),
                            token: m.as_str().trim().to_string(),
                        });
                    }
                }

                if !out.is_empty() {
                    push_runtime_log(
                        &log_state,
                        format!(
                            "ONVIF recordings search finished for {} via {} (tokens: {})",
                            clean_host,
                            endpoint,
                            out.len()
                        ),
                    );
                    return Ok(out);
                }
            }
            Err(_) => {}
        }
    }

    push_runtime_log(
        &log_state,
        format!("ONVIF recordings search unavailable for {}", clean_host),
    );
    Err("ONVIF recording_service недоступен или не вернул recording tokens".into())
}

#[tauri::command]
async fn probe_archive_export_endpoints(
    host: String,
    login: String,
    pass: String,
    log_state: State<'_, LogState>,
) -> Result<Vec<ArchiveEndpointResult>, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для проверки endpoint экспорта".into());
    }

    push_runtime_log(
        &log_state,
        format!("Archive endpoint probe started for {}", clean_host),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let candidates: Vec<(String, String, String)> = vec![
        (
            "ISAPI".into(),
            "GET".into(),
            format!("http://{}:80/ISAPI/ContentMgmt/search", clean_host),
        ),
        (
            "ISAPI".into(),
            "GET".into(),
            format!("http://{}:80/ISAPI/ContentMgmt/record/tracks", clean_host),
        ),
        (
            "ISAPI".into(),
            "GET".into(),
            format!("https://{}:443/ISAPI/ContentMgmt/search", clean_host),
        ),
        (
            "ISAPI".into(),
            "GET".into(),
            format!("https://{}:443/ISAPI/ContentMgmt/record/tracks", clean_host),
        ),
        (
            "ONVIF".into(),
            "POST".into(),
            format!("http://{}:80/onvif/recording_service", clean_host),
        ),
        (
            "ONVIF".into(),
            "POST".into(),
            format!("http://{}:8080/onvif/recording_service", clean_host),
        ),
        (
            "ONVIF".into(),
            "POST".into(),
            format!("https://{}:443/onvif/recording_service", clean_host),
        ),
        (
            "ONVIF".into(),
            "POST".into(),
            format!("https://{}:8443/onvif/recording_service", clean_host),
        ),
    ];

    let onvif_probe_soap = r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl">
  <s:Body>
    <trc:GetRecordings/>
  </s:Body>
</s:Envelope>"#;

    let mut out = Vec::with_capacity(candidates.len());

    for (protocol, method, endpoint) in candidates {
        let resp = if method == "GET" {
            client
                .get(&endpoint)
                .basic_auth(login.clone(), Some(pass.clone()))
                .send()
                .await
        } else {
            client
                .post(&endpoint)
                .header("Content-Type", "application/soap+xml; charset=utf-8")
                .basic_auth(login.clone(), Some(pass.clone()))
                .body(onvif_probe_soap.to_string())
                .send()
                .await
        };

        let item = match resp {
            Ok(r) => {
                let code = r.status().as_u16();
                let status = if code == 200 || code == 401 || code == 405 {
                    "detected"
                } else {
                    "not_detected"
                };
                ArchiveEndpointResult {
                    protocol,
                    endpoint,
                    method,
                    status: status.into(),
                    status_code: Some(code),
                }
            }
            Err(_) => ArchiveEndpointResult {
                protocol,
                endpoint,
                method,
                status: "unreachable".into(),
                status_code: None,
            },
        };

        out.push(item);
    }

    let detected = out.iter().filter(|x| x.status == "detected").count();
    push_runtime_log(
        &log_state,
        format!(
            "Archive endpoint probe finished for {} (detected: {})",
            clean_host, detected
        ),
    );

    Ok(out)
}

#[tauri::command]
async fn download_onvif_recording_token(
    endpoint: String,
    recording_token: String,
    login: String,
    pass: String,
    filename_hint: Option<String>,
    task_id: Option<String>,
    log_state: State<'_, LogState>,
    cancel_state: State<'_, DownloadCancelState>,
) -> Result<DownloadReport, String> {
    if endpoint.trim().is_empty() {
        return Err("Пустой endpoint для ONVIF download".into());
    }
    if recording_token.trim().is_empty() {
        return Err("Пустой recording_token".into());
    }

    let task_key = task_id.unwrap_or_else(|| format!("onvif_{}", Utc::now().timestamp_millis()));
    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    push_runtime_log(
        &log_state,
        format!(
            "ONVIF download requested: token {} via {} [task:{}]",
            recording_token, endpoint, task_key
        ),
    );

    let soap = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trp="http://www.onvif.org/ver10/replay/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>
    <trp:GetReplayUri>
      <trp:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport>
          <tt:Protocol>RTSP</tt:Protocol>
        </tt:Transport>
      </trp:StreamSetup>
      <trp:RecordingToken>{}</trp:RecordingToken>
    </trp:GetReplayUri>
  </s:Body>
</s:Envelope>"#,
        recording_token
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let replay_resp = client
        .post(&endpoint)
        .header("Content-Type", "application/soap+xml; charset=utf-8")
        .basic_auth(login.clone(), Some(pass.clone()))
        .body(soap)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let replay_body = replay_resp.text().await.map_err(|e| e.to_string())?;
    let uri_re = Regex::new(r"<[^>]*Uri[^>]*>([^<]+)</[^>]+>").map_err(|e| e.to_string())?;
    let replay_uri = uri_re
        .captures(&replay_body)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .ok_or_else(|| "ONVIF replay URI не найден в ответе GetReplayUri".to_string())?;

    push_runtime_log(
        &log_state,
        format!("ONVIF replay URI resolved for token {}", recording_token),
    );

    let replay_uri_lc = replay_uri.to_ascii_lowercase();
    if replay_uri_lc.starts_with("rtsp://") || replay_uri_lc.starts_with("rtsps://") {
        push_runtime_log(
            &log_state,
            format!(
                "ONVIF replay URI for token {} is RTSP, starting ffmpeg capture: {}",
                recording_token, replay_uri
            ),
        );

        let mut filename = filename_hint
            .clone()
            .map(|s| sanitize_filename_component(&s))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("onvif_record_{}.mp4", Utc::now().timestamp()));
        if !filename.contains('.') {
            filename.push_str(".mp4");
        }

        let path = get_vault_path()
            .join("archives")
            .join("onvif")
            .join(&filename);
        let _ = std::fs::create_dir_all(path.parent().unwrap());

        let ffmpeg = get_vault_path().join("ffmpeg.exe");
        let output_path = path.to_string_lossy().to_string();
        let mut child = Command::new(&ffmpeg)
            .args([
                "-y",
                "-rtsp_transport",
                "tcp",
                "-i",
                &replay_uri,
                "-c",
                "copy",
                &output_path,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Не удалось запустить ffmpeg для ONVIF RTSP: {}", e))?;

        let started = std::time::Instant::now();
        let mut last_progress_log = std::time::Instant::now();
        let mut last_size: u64 = 0;
        loop {
            if cancel_state
                .cancelled_tasks
                .lock()
                .map(|set| set.contains(&task_key))
                .unwrap_or(false)
            {
                let _ = child.kill();
                let _ = std::fs::remove_file(&path);
                if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
                    cancelled.remove(&task_key);
                }
                push_runtime_log(
                    &log_state,
                    format!("DOWNLOAD_CANCELLED|{}|{}", task_key, filename),
                );
                return Err(format!(
                    "Загрузка отменена пользователем [task:{}]",
                    task_key
                ));
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let stderr_preview = if let Some(mut stderr) = child.stderr.take() {
                            use std::io::Read;
                            let mut buf = String::new();
                            let _ = stderr.read_to_string(&mut buf);
                            buf.lines()
                                .rev()
                                .take(5)
                                .collect::<Vec<_>>()
                                .into_iter()
                                .rev()
                                .collect::<Vec<_>>()
                                .join(" | ")
                        } else {
                            String::new()
                        };
                        let tail = if stderr_preview.is_empty() {
                            "нет stderr от ffmpeg".to_string()
                        } else {
                            format!("stderr: {}", stderr_preview)
                        };
                        return Err(format!(
                            "ffmpeg завершился с ошибкой: {} ({})",
                            status, tail
                        ));
                    }
                    break;
                }
                Ok(None) => {}
                Err(e) => return Err(format!("Ошибка ожидания ffmpeg: {}", e)),
            }

            if last_progress_log.elapsed() >= std::time::Duration::from_secs(1) {
                let current_size = std::fs::metadata(&path)
                    .map(|m| m.len())
                    .unwrap_or(last_size);
                if current_size > last_size {
                    push_runtime_log(
                        &log_state,
                        format!("DOWNLOAD_PROGRESS|{}|{}|0", task_key, current_size),
                    );
                    last_size = current_size;
                }
                last_progress_log = std::time::Instant::now();
            }

            if started.elapsed() > std::time::Duration::from_secs(180) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Таймаут ONVIF RTSP capture (180s)".into());
            }

            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        let bytes_written = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let duration_ms = started.elapsed().as_millis();

        push_runtime_log(
            &log_state,
            format!(
                "DOWNLOAD_PROGRESS|{}|{}|{}",
                task_key, bytes_written, bytes_written
            ),
        );
        push_runtime_log(
            &log_state,
            format!(
                "ONVIF RTSP download finished: {} ({} bytes, {} ms) [task:{}]",
                filename, bytes_written, duration_ms, task_key
            ),
        );

        if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
            cancelled.remove(&task_key);
        }

        return Ok(DownloadReport {
            server_alias: "onvif".into(),
            filename,
            save_path: path.to_string_lossy().to_string(),
            bytes_written,
            total_bytes: bytes_written,
            duration_ms,
            resumed: false,
            skipped_as_complete: false,
        });
    }

    if !replay_uri_lc.starts_with("http://") && !replay_uri_lc.starts_with("https://") {
        return Err(format!("Неподдерживаемая схема replay URI: {}", replay_uri));
    }

    let started = std::time::Instant::now();
    let resp = client
        .get(&replay_uri)
        .basic_auth(login, Some(pass))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "ONVIF download failed with HTTP {}",
            resp.status().as_u16()
        ));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut filename = filename_hint
        .map(|s| sanitize_filename_component(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("onvif_record_{}.mp4", Utc::now().timestamp()));
    if !filename.contains('.') {
        filename.push_str(".mp4");
    }

    let path = get_vault_path()
        .join("archives")
        .join("onvif")
        .join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());

    let mut stream = resp.bytes_stream();
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    let mut bytes_written: u64 = 0;
    let progress_step = 2 * 1024 * 1024u64;
    let mut next_progress_mark = progress_step;

    while let Some(chunk) = stream.next().await {
        if cancel_state
            .cancelled_tasks
            .lock()
            .map(|set| set.contains(&task_key))
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&path);
            if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
                cancelled.remove(&task_key);
            }
            push_runtime_log(
                &log_state,
                format!("DOWNLOAD_CANCELLED|{}|{}", task_key, filename),
            );
            return Err(format!(
                "Загрузка отменена пользователем [task:{}]",
                task_key
            ));
        }

        let data = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &data).map_err(|e| e.to_string())?;
        bytes_written += data.len() as u64;

        if bytes_written >= next_progress_mark {
            push_runtime_log(
                &log_state,
                format!(
                    "DOWNLOAD_PROGRESS|{}|{}|{}",
                    task_key,
                    bytes_written,
                    total_size.max(bytes_written)
                ),
            );
            next_progress_mark += progress_step;
        }
    }

    let duration_ms = started.elapsed().as_millis();
    push_runtime_log(
        &log_state,
        format!(
            "ONVIF download finished: {} ({} bytes, {} ms) [task:{}]",
            filename, bytes_written, duration_ms, task_key
        ),
    );

    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    Ok(DownloadReport {
        server_alias: "onvif".into(),
        filename,
        save_path: path.to_string_lossy().to_string(),
        bytes_written,
        total_bytes: total_size.max(bytes_written),
        duration_ms,
        resumed: false,
        skipped_as_complete: false,
    })
}

#[tauri::command]
async fn download_isapi_playback_uri(
    playback_uri: String,
    login: String,
    pass: String,
    filename_hint: Option<String>,
    task_id: Option<String>,
    log_state: State<'_, LogState>,
    cancel_state: State<'_, DownloadCancelState>,
) -> Result<DownloadReport, String> {
    if playback_uri.trim().is_empty() {
        return Err("Пустой playback_uri".into());
    }

    let task_key = task_id.unwrap_or_else(|| format!("isapi_{}", Utc::now().timestamp_millis()));
    push_runtime_log(
        &log_state,
        format!(
            "ISAPI download requested: {} [task:{}]",
            playback_uri, task_key
        ),
    );

    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let started = std::time::Instant::now();
    let resp = client
        .get(&playback_uri)
        .basic_auth(login, Some(pass))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "ISAPI download failed with HTTP {}",
            resp.status().as_u16()
        ));
    }

    let total_size = resp.content_length().unwrap_or(0);

    let mut filename = filename_hint
        .map(|s| sanitize_filename_component(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("isapi_record_{}.mp4", Utc::now().timestamp()));
    if !filename.contains('.') {
        filename.push_str(".mp4");
    }

    let path = get_vault_path()
        .join("archives")
        .join("isapi")
        .join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());

    let mut stream = resp.bytes_stream();
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    let mut bytes_written: u64 = 0;
    let progress_step = 2 * 1024 * 1024u64;
    let mut next_progress_mark = progress_step;

    while let Some(chunk) = stream.next().await {
        if cancel_state
            .cancelled_tasks
            .lock()
            .map(|set| set.contains(&task_key))
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&path);
            if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
                cancelled.remove(&task_key);
            }
            push_runtime_log(
                &log_state,
                format!("DOWNLOAD_CANCELLED|{}|{}", task_key, filename),
            );
            return Err(format!(
                "Загрузка отменена пользователем [task:{}]",
                task_key
            ));
        }

        let data = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &data).map_err(|e| e.to_string())?;
        bytes_written += data.len() as u64;

        if bytes_written >= next_progress_mark {
            push_runtime_log(
                &log_state,
                format!(
                    "DOWNLOAD_PROGRESS|{}|{}|{}",
                    task_key,
                    bytes_written,
                    total_size.max(bytes_written)
                ),
            );
            next_progress_mark += progress_step;
        }
    }

    let duration_ms = started.elapsed().as_millis();
    push_runtime_log(
        &log_state,
        format!(
            "ISAPI download finished: {} ({} bytes, {} ms) [task:{}]",
            filename, bytes_written, duration_ms, task_key
        ),
    );

    if let Ok(mut cancelled) = cancel_state.cancelled_tasks.lock() {
        cancelled.remove(&task_key);
    }

    Ok(DownloadReport {
        server_alias: "isapi".into(),
        filename,
        save_path: path.to_string_lossy().to_string(),
        bytes_written,
        total_bytes: total_size.max(bytes_written),
        duration_ms,
        resumed: false,
        skipped_as_complete: false,
    })
}

#[tauri::command]
fn get_implementation_status() -> Result<ImplementationStatus, String> {
    let items = vec![
        RoadmapItem {
            name: "Vault encryption + sled storage".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Live stream engine (RTSP/MJPEG -> HLS)".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Hub/Shodan/Videodvor discovery".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "FTP resilience (banner/retry/resume)".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Automatic host service/port scanner".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "ISAPI/ONVIF archive extraction".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Download manager UX (queue/cancel/persist)".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Map filtering for >100 targets".into(),
            status: "completed".into(),
        },
        RoadmapItem {
            name: "Embedded runtime logs terminal".into(),
            status: "completed".into(),
        },
    ];

    let total = items.len();
    let completed = items.iter().filter(|i| i.status == "completed").count();
    let in_progress = items.iter().filter(|i| i.status == "in_progress").count();
    let pending = items.iter().filter(|i| i.status == "pending").count();

    Ok(ImplementationStatus {
        total,
        completed,
        in_progress,
        pending,
        left: total.saturating_sub(completed),
        items,
    })
}

fn main() {
    dotenv().ok();
    start_background_scheduler();

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
            let cors = warp::cors()
                .allow_any_origin()
                .allow_headers(vec!["Range", "User-Agent", "Content-Type", "Accept"])
                .allow_methods(vec!["GET", "OPTIONS"]);
            warp::serve(warp::fs::dir(server_path).with(cors))
                .run(([127, 0, 0, 1], 49152))
                .await;
        });
    });

    tauri::Builder::default()
        .manage(StreamState {
            active_streams: std::sync::Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_shell::init())
        .manage(videodvor_state)
        .manage(LogState {
            lines: std::sync::Mutex::new(vec!["[boot] runtime log started".into()]),
        })
        .manage(DownloadCancelState {
            cancelled_tasks: std::sync::Mutex::new(HashSet::new()),
        })
        .invoke_handler(tauri::generate_handler![
            save_target,
            read_target,
            get_all_targets,
            delete_target,
            start_stream,
            stop_stream,
            geocode_address,
            generate_nvr_channels,
            probe_rtsp_path,
            search_global_hub,
            get_ftp_folders,
            download_ftp_file,
            videodvor_login,
            videodvor_scrape,
            videodvor_list_archive,
            videodvor_download_file,
            shodan_search,
            start_hub_stream,
            scan_host_ports,
            get_runtime_logs,
            cancel_download_task,
            probe_nvr_protocols,
            fetch_nvr_device_info,
            fetch_onvif_device_info,
            search_isapi_recordings,
            search_onvif_recordings,
            download_onvif_recording_token,
            download_isapi_playback_uri,
            probe_archive_export_endpoints,
            get_implementation_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn scan_host_ports(
    host: String,
    log_state: State<'_, LogState>,
) -> Result<Vec<PortProbeResult>, String> {
    let clean_host = normalize_host_for_scan(&host);
    if clean_host.is_empty() {
        return Err("Пустой host для сканирования".into());
    }

    push_runtime_log(&log_state, format!("Port scan started for {}", clean_host));

    let ports = [21u16, 22, 80, 443, 554, 8080, 8443];
    let mut result = Vec::with_capacity(ports.len());

    for port in ports {
        let addr = format!("{}:{}", clean_host, port);
        let open = timeout(Duration::from_millis(900), TcpStream::connect(addr))
            .await
            .is_ok_and(|v| v.is_ok());

        result.push(PortProbeResult {
            port,
            service: guess_service(port).to_string(),
            open,
        });
    }

    let open_count = result.iter().filter(|x| x.open).count();
    push_runtime_log(
        &log_state,
        format!(
            "Port scan finished for {} (open: {})",
            clean_host, open_count
        ),
    );
    Ok(result)
}
