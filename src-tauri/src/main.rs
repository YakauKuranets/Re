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
use chrono::Utc;
use dotenv::dotenv;
use std::env;
use serde::Serialize;

mod videodvor_scanner;

struct StreamState {
    active_streams: std::sync::Mutex<HashMap<String, std::process::Child>>,
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
    let record = DeviceRecord { id: device_id.to_string(), ip: ip.to_string(), first_seen: now, last_seen: now };
    let value = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    db.insert(key.as_bytes(), value).map_err(|e| e.to_string())?;
    Ok(())
}

// --- ИНТЕГРАЦИЯ SHODAN ---
#[tauri::command]
async fn shodan_search(country: String, city: String) -> Result<Vec<Value>, String> {
    let api_key = env::var("SHODAN_API_KEY").unwrap_or_default();
    let client = reqwest::Client::new();
    let query = format!("webcam port:80,554 country:{} city:{}", country, city);
    let url = format!("https://api.shodan.io/shodan/host/search?key={}&query={}", api_key, urlencoding::encode(&query));

    let res: Value = client.get(&url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
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
fn start_hub_stream(target_id: String, user_id: String, channel_id: String, cookie: String, state: State<'_, StreamState>) -> Result<String, String> {
    let cache = get_vault_path().join("hls_cache").join(&target_id);
    let _ = std::fs::create_dir_all(&cache);
    let playlist = cache.join("stream.m3u8");

    {
        let mut streams = state.active_streams.lock().unwrap();
        if let Some(mut old) = streams.remove(&target_id) { let _ = old.kill(); }
    }

    let url = format!("https://videodvor.by/stream/rtsp2mjpeg.php?get=1&user=user{}&id={}", user_id, channel_id);

    // ВАЖНО: FFmpeg требует строгих переносов \r\n.
    // И мы добавляем Referer: admin.php, чтобы обмануть защиту Хаба!
    let headers = format!("Cookie: {}\r\nReferer: https://videodvor.by/stream/admin.php\r\n", cookie);

    let child = Command::new(get_vault_path().join("ffmpeg.exe"))
        .args([
            "-headers", &headers,
            "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
            "-probesize", "10000000",
            "-analyzeduration", "10000000",
            "-use_wallclock_as_timestamps", "1",
            "-f", "mpjpeg",
            "-y",
            "-i", &url,
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

// --- ИСПРАВЛЕННЫЙ СКАНЕР: НАХОДИТ ВСЕ КАНАЛЫ (КАМЕРЫ) ---
#[tauri::command]
async fn search_global_hub(query: String, cookie: String) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    let encoded_query = urlencoding::encode(&query);
    let url = format!("https://videodvor.by/stream/check.php?search={}", encoded_query);

    let res = client.get(&url).header("Cookie", cookie).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;

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
            if channels.is_empty() { channels.push("0".to_string()); }

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
        rt.block_on(async { loop { tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await; } });
    });
}

#[tauri::command]
fn save_target(target_id: String, payload: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    let cipher = Aes256Gcm::new(&derive_hardware_key().into());
    let encrypted_data = cipher.encrypt(Nonce::from_slice(b"nemesis_salt"), payload.as_bytes()).map_err(|_| "Encryption error".to_string())?;
    db.insert(target_id.as_bytes(), encrypted_data).map_err(|e: sled::Error| e.to_string())?;
    Ok("Saved".into())
}

#[tauri::command]
fn read_target(target_id: String) -> Result<String, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    if let Some(data) = db.get(target_id.as_bytes()).map_err(|e: sled::Error| e.to_string())? {
        let cipher = Aes256Gcm::new(&derive_hardware_key().into());
        let decrypted = cipher.decrypt(Nonce::from_slice(b"nemesis_salt"), data.as_ref()).map_err(|_| "Access denied".to_string())?;
        String::from_utf8(decrypted).map_err(|_| "UTF-8 error".to_string())
    } else { Err("Not found".to_string()) }
}

#[tauri::command]
fn get_all_targets() -> Result<Vec<String>, String> {
    let db = sled::open(get_vault_path().join("targets_vault")).map_err(|e: sled::Error| e.to_string())?;
    let mut keys = Vec::new();
    for k in db.iter().keys() {
        if let Ok(key_bytes) = k { if let Ok(s) = String::from_utf8(key_bytes.to_vec()) { keys.push(s); } }
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
        .args(["-rtsp_transport", "tcp", "-timeout", "5000000", "-y", "-i", &rtsp_url, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-an", "-f", "hls", "-hls_time", "1", "-hls_list_size", "3", "-hls_flags", "delete_segments+append_list", playlist.to_str().unwrap()])
        .spawn().map_err(|e| e.to_string())?;
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

// --- НОВЫЙ БЛОК FTP-НАВИГАТОРА ---

#[derive(Serialize)]
pub struct FtpFolder {
    pub name: String,
    pub path: String,
}

#[tauri::command]
fn get_ftp_folders(server_alias: &str) -> Result<Vec<FtpFolder>, String> {
    println!("\n[FTP ЯДРО] Запуск глубокой разведки для: {}", server_alias);

    let (host, _user, _pass) = match server_alias {
        "video1" => ("93.125.48.66:21", "mvd", "gpfZrw%9RVqp"),
        "video2" => ("93.125.48.100:21", "mvd", "gpfZrw%9RVqp"),
        _ => return Err(format!("Неизвестный сервер: {}", server_alias)),
    };

    println!("[ДЕТЕКТОР 3.0] Соединяемся с портом 21 ({})...", host);
    if let Ok(mut stream) = std::net::TcpStream::connect(host) {
        // Даем серверу до 15 секунд на раздумья
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(15)));
        let mut buf = [0; 4096];

        println!("[ДЕТЕКТОР 3.0] Соединение установлено. Слушаю эфир в режиме тишины...");

        if let Ok(n) = std::io::Read::read(&mut stream, &mut buf) {
            let raw_str = String::from_utf8_lossy(&buf[..n]);
            println!("\n=== ИСТИННЫЙ ОТВЕТ СЕРВЕРА ===");
            println!("Текст: {}", raw_str.trim());
            println!("Байты: {:?}", &buf[..n]);
            println!("==============================\n");

            // Выводим ответ прямо тебе в интерфейс карты
            return Err(format!("БАННЕР ПЕРЕХВАЧЕН:\n{}", raw_str.trim()));
        } else {
            println!("\n=== ИСТИННЫЙ ОТВЕТ СЕРВЕРА ===\n[Таймаут 15 секунд. Сервер так ничего и не прислал.]\n==============================\n");
            return Err("Сервер молчит даже спустя 15 секунд.".into());
        }
    }

    Err("Порт аппаратно закрыт или недоступен".into())
}

#[tauri::command]
fn download_ftp_file(server_alias: &str, folder_path: String, filename: String) -> Result<String, String> {
    println!("\n[FTP ЯДРО] Скачивание файла {} с {}", filename, server_alias);

    let (host, user, pass) = match server_alias {
        "video1" => ("93.125.48.66:21", "mvd", "gpfZrw%9RVqp"),
        "video2" => ("93.125.48.100:21", "mvd", "gpfZrw%9RVqp"),
        _ => return Err("Неизвестный сервер".into()),
    };

    let mut ftp = FtpStream::connect(host).map_err(|e| e.to_string())?;
    ftp.login(user, pass).map_err(|e| e.to_string())?;

    // ФОРСИРУЕМ ПАССИВНЫЙ РЕЖИМ
    ftp.set_mode(suppaftp::Mode::Passive);

    if folder_path != "/" && !folder_path.is_empty() {
        ftp.cwd(&folder_path).map_err(|e| e.to_string())?;
    }

    println!("[FTP ЯДРО] Передача данных...");
    let data = ftp.retr_as_buffer(&filename).map_err(|e| e.to_string())?;

    let path = get_vault_path().join("archives").join(server_alias).join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    std::fs::write(&path, data.into_inner()).map_err(|e| e.to_string())?;

    println!("[FTP ЯДРО] Скачивание завершено успешно!");
    let _ = ftp.quit();
    Ok("Ok".into())
}

#[tauri::command]
async fn videodvor_login(username: String, password: String, state: tauri::State<'_, VideodvorState>) -> Result<String, String> {
    let mut scanner = state.scanner.lock().await;
    scanner.login(&username, &password).await?;
    Ok("Logged in".into())
}

#[tauri::command]
async fn videodvor_scrape(state: tauri::State<'_, VideodvorState>) -> Result<Vec<serde_json::Value>, String> {
    let scanner = state.scanner.lock().await;
    scanner.scrape_all_cameras().await
}

#[tauri::command]
async fn videodvor_list_archive(ip: String, state: tauri::State<'_, VideodvorState>) -> Result<Vec<String>, String> {
    let scanner = state.scanner.lock().await;
    scanner.get_archive_files(&ip).await
}

#[tauri::command]
async fn videodvor_download_file(ip: String, filename: String, state: tauri::State<'_, VideodvorState>) -> Result<String, String> {
    let scanner = state.scanner.lock().await;
    scanner.download_file(&ip, &filename).await?;
    Ok("Download started".into())
}

// --- ФУНКЦИИ ДЛЯ СОВМЕСТИМОСТИ С videodvor_scanner.rs ---

pub fn scan_ftp_archive(ip: String, ftp_host: String, ftp_user: String, ftp_pass: String) -> Result<Vec<String>, String> {
    let mut ftp = suppaftp::FtpStream::connect(format!("{}:21", ftp_host)).map_err(|e| e.to_string())?;
    ftp.login(&ftp_user, &ftp_pass).map_err(|e| e.to_string())?;

    // ФОРСИРУЕМ ПАССИВНЫЙ РЕЖИМ
    ftp.set_mode(suppaftp::Mode::Passive);

    if ip != "/" && !ip.is_empty() {
        let _ = ftp.cwd(&ip);
    }
    let list = ftp.nlst(None).map_err(|e| e.to_string())?;
    let _ = ftp.quit();
    Ok(list)
}

pub fn download_ftp_scanner(ip: String, filename: String, ftp_host: String, ftp_user: String, ftp_pass: String) -> Result<String, String> {
    let mut ftp = suppaftp::FtpStream::connect(format!("{}:21", ftp_host)).map_err(|e| e.to_string())?;
    ftp.login(&ftp_user, &ftp_pass).map_err(|e| e.to_string())?;

    // ФОРСИРУЕМ ПАССИВНЫЙ РЕЖИМ
    ftp.set_mode(suppaftp::Mode::Passive);

    let _ = ftp.cwd(&ip);
    let data = ftp.retr_as_buffer(&filename).map_err(|e| e.to_string())?;

    // Путь сохранения для сканера
    let path = get_vault_path().join("archives").join(&ip).join(&filename);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    std::fs::write(&path, data.into_inner()).map_err(|e| e.to_string())?;

    let _ = ftp.quit();
    Ok("Ok".into())
}


fn main() {
    dotenv().ok();
    start_background_scheduler();

    let hls_path = get_vault_path().join("hls_cache");
    let _ = std::fs::create_dir_all(&hls_path);
    let server_path = hls_path.clone();
    let videodvor = videodvor_scanner::VideodvorScanner::new();
    let videodvor_state = VideodvorState { scanner: Mutex::new(videodvor) };

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let cors = warp::cors().allow_any_origin().allow_headers(vec!["Range", "User-Agent", "Content-Type", "Accept"]).allow_methods(vec!["GET", "OPTIONS"]);
            warp::serve(warp::fs::dir(server_path).with(cors)).run(([127, 0, 0, 1], 49152)).await;
        });
    });

    tauri::Builder::default()
        .manage(StreamState { active_streams: std::sync::Mutex::new(HashMap::new()) })
        .plugin(tauri_plugin_shell::init())
        .manage(videodvor_state)
        .invoke_handler(tauri::generate_handler![
            save_target, read_target, get_all_targets, delete_target,
            start_stream, stop_stream, geocode_address, generate_nvr_channels,
            probe_rtsp_path, search_global_hub, get_ftp_folders, download_ftp_file,
            videodvor_login, videodvor_scrape, videodvor_list_archive, videodvor_download_file,
            shodan_search, start_hub_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}