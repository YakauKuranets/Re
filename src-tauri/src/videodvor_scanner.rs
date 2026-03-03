// videodvor_scanner.rs
use regex::Regex;
use reqwest::{Client, header};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::sleep;

const LOGIN_URL: &str = "https://videodvor.by/stream/admin.php";
const CHECK_URL: &str = "https://videodvor.by/stream/admin.php";

pub struct VideodvorScanner {
    client: Client,
    cookie: Option<String>,
}

impl VideodvorScanner {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
            .cookie_store(true)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client");
        Self { client, cookie: None }
    }

    /// Выполняет вход и сохраняет сессионную cookie.
    pub async fn login(&mut self, username: &str, password: &str) -> Result<(), String> {
        let params = [("username", username), ("password", password)];
        let resp = self.client
            .post(LOGIN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let cookies = resp.headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|h| h.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or("").to_string())
            .collect::<Vec<_>>()
            .join("; ");

        if cookies.is_empty() {
            return Err("No session cookie received".into());
        }

        self.cookie = Some(cookies);
        Ok(())
    }

    /// Собирает все камеры с портала, проходя по страницам.
    pub async fn scrape_all_cameras(&self) -> Result<Vec<Value>, String> {
        let cookie = self.cookie.as_ref().ok_or("Not logged in")?;
        let mut all = Vec::new();
        let mut offset = 0;
        const LIMIT: usize = 100;

        loop {
            let url = format!("{}?search=&offset={}&limit={}", CHECK_URL, offset, LIMIT);
            let resp = self.client
                .get(&url)
                .header(header::COOKIE, cookie)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let text = resp.text().await.map_err(|e| e.to_string())?;

            let re = Regex::new(r#"id="(\d+)".*?ip="(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})""#).unwrap();
            let mut found = 0;
            for cap in re.captures_iter(&text) {
                let cam_id = cap[1].to_string();
                let ip = cap[2].to_string();
                all.push(json!({ "id": cam_id, "ip": ip }));
                found += 1;
            }

            if found < LIMIT {
                break;
            }
            offset += LIMIT;
            sleep(Duration::from_millis(500)).await; // задержка между запросами
        }
        Ok(all)
    }

    /// Получить список архивных файлов для камеры по IP через FTP.
    /// Использует существующие команды scan_ftp_archive.
    pub async fn get_archive_files(&self, ip: &str) -> Result<Vec<String>, String> {
        let ftp_hosts = ["93.125.48.66", "93.125.48.100"];
        let ftp_user = "mvd";
        let ftp_pass = "gpfZrw%9RVqp";

        for &host in &ftp_hosts {
            match crate::scan_ftp_archive(
                ip.to_string(),
                host.to_string(),
                ftp_user.to_string(),
                ftp_pass.to_string(),
            ) {  // убрали .await
                Ok(files) => return Ok(files),
                Err(_) => continue,
            }
    }
    Err("No archive found on any FTP server".into())
    }

    /// Скачать конкретный файл с FTP.
    pub async fn download_file(&self, ip: &str, filename: &str) -> Result<(), String> {
        let ftp_hosts = ["93.125.48.66", "93.125.48.100"];
        let ftp_user = "mvd";
        let ftp_pass = "gpfZrw%9RVqp";

        for &host in &ftp_hosts {
            match crate::download_ftp_scanner(
                ip.to_string(),
                filename.to_string(),
                host.to_string(),
                ftp_user.to_string(),
                ftp_pass.to_string(),
            ) {  // убрали .await
                Ok(_) => return Ok(()),
                Err(_) => continue,
            }
    }
    Err("Failed to download from any FTP server".into())
}
}