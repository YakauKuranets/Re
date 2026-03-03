use serde::Serialize;
use suppaftp::FtpStream;

#[derive(Serialize)]
pub struct FtpFolder {
    pub name: String,
    pub path: String,
}

// Эта команда будет вызываться из твоего JavaScript
#[tauri::command]
pub fn get_ftp_folders(server_alias: &str) -> Result<Vec<FtpFolder>, String> {
    // Выбираем IP по имени
    let (host, user, pass) = match server_alias {
        "video1" => ("93.125.48.66:21", "mvd", "gpfZrw%9RVqp"),
        "video2" => ("93.125.48.100:21", "mvd", "gpfZrw%9RVqp"),
        _ => return Err(format!("Неизвестный сервер: {}", server_alias)),
    };

    // Подключаемся и логинимся
    let mut ftp_stream = FtpStream::connect(host).map_err(|e| e.to_string())?;
    ftp_stream.login(user, pass).map_err(|e| e.to_string())?;

    // Получаем список имен в корневой директории ("/")
    let list = ftp_stream.nlst(Some("/")).map_err(|e| e.to_string())?;

    let mut folders = Vec::new();
    for item in list {
        let name = item.trim_start_matches('/').to_string();

        // Отсекаем служебные пути
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }

        folders.push(FtpFolder {
            name: name.clone(),
            path: format!("/{}", name),
        });
    }

    // Корректно закрываем соединение
    let _ = ftp_stream.quit();
    Ok(folders)
}