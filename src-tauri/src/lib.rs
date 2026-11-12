use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{async_runtime, Emitter, State};
use walkdir::WalkDir;

// ----- Structs -----
#[derive(Serialize, Deserialize, Debug)]
pub struct ScanResult {
    volume_label: String,
    base_folder: String,
    total_files: usize,
    errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DupEntry {
    volume_label: String,
    base_folder: String,
    rel_path: String,
    size: i64,
    file_ext: String,
}

// ----- State -----
pub struct AppState {
    scan_cancel_flag: Arc<AtomicBool>,
    dup_cancel_flag: Arc<AtomicBool>,
}

// ----- Helpers -----
fn get_db_conn() -> Connection {
    let mut db_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    db_dir.push("com.yawstar.du-finder");
    if !db_dir.exists() {
        fs::create_dir_all(&db_dir).expect("Failed to create DB directory");
    }
    let db_path = db_dir.join("files.db");
    Connection::open(db_path).expect("Failed to open DB")
}

// ----- Get Volume Label [Windows] -----
#[cfg(target_os = "windows")]
fn get_volume_label(path: &str) -> String {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::fileapi::GetVolumeInformationW;

    let p = Path::new(path);
    if let Some(prefix) = p.components().next() {
        let mut drive_letter = prefix.as_os_str().to_string_lossy().replace("\\", "");
        if !drive_letter.ends_with(':') {
            drive_letter.push(':');
        }
        let drive_letter = format!("{}\\", drive_letter);
        let root: Vec<u16> = OsStr::new(&drive_letter).encode_wide().chain(std::iter::once(0)).collect();
        let mut volume_name = [0u16; 256];
        let mut fs_name = [0u16; 256];

        unsafe {
            let success = GetVolumeInformationW(
                root.as_ptr(),
                volume_name.as_mut_ptr(),
                volume_name.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs_name.as_mut_ptr(),
                fs_name.len() as u32,
            );

            if success != 0 {
                let len = volume_name.iter().position(|&c| c == 0).unwrap_or(volume_name.len());
                let label = String::from_utf16_lossy(&volume_name[..len]);
                if !label.trim().is_empty() {
                    return label.trim().to_string();
                }
            }
        }
        return drive_letter.replace("\\", "");
    }
    "Unknown".to_string()
}

// ----- Get Volume Label [Mac / Linux] -----
#[cfg(not(target_os = "windows"))]
fn get_volume_label(path: &str) -> String {
    let p = Path::new(path);
    if let Some(prefix) = p.components().next() {
        let label = prefix.as_os_str().to_string_lossy().replace("/", "");
        if !label.is_empty() {
            return label;
        }
    }
    let p_str = path.to_string();
    if p_str == "/" {
        return "Root".to_string();
    }
    "Unknown".to_string()
}

// ----- Tauri Commands -----

#[tauri::command]
fn init_db() -> Result<(), String> {
    let conn = get_db_conn();
    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volume_label TEXT NOT NULL,
            base_folder TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_ext TEXT,
            rel_path TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime REAL NOT NULL,
            scanned_at REAL NOT NULL,
            UNIQUE(volume_label, base_folder, rel_path)
        )",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.scan_cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn cancel_duplicate_search(state: State<'_, AppState>) {
    state.dup_cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn scan_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder_path: String,
    allowed_exts: Vec<String>,
) -> Result<ScanResult, String> {
    state.scan_cancel_flag.store(false, Ordering::Relaxed);
    let cancel_flag = state.scan_cancel_flag.clone();

    let result = async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&folder_path);
        if !base.exists() || !base.is_dir() {
            return Err(format!("Folder မတွေ့ပါ: {}", folder_path));
        }

        let volume_label = get_volume_label(&folder_path);
        let conn = get_db_conn();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
        
        let mut files_to_insert = Vec::new();
        let mut errors = Vec::new();
        let mut count = 0;

        conn.execute(
            "DELETE FROM files WHERE volume_label = ?1 AND base_folder = ?2",
            params![volume_label, folder_path],
        ).map_err(|e| e.to_string())?;

        for entry in WalkDir::new(&base).into_iter().filter_map(|e| e.ok()) {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Scan cancelled by user".to_string());
            }

            if entry.file_type().is_file() {
                let path = entry.path();
                let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();

                if !allowed_exts.is_empty() && !allowed_exts.contains(&ext) {
                    continue;
                }

                match std::fs::metadata(path) {
                    Ok(meta) => {
                        let rel_path = path.strip_prefix(&base).unwrap_or(path).to_string_lossy().to_string();
                        let size = meta.len() as i64;
                        let mtime = meta.modified().unwrap_or(SystemTime::now())
                            .duration_since(UNIX_EPOCH).unwrap().as_secs_f64();

                        files_to_insert.push((
                            volume_label.clone(), folder_path.clone(), filename, ext, rel_path, size, mtime, now
                        ));
                        count += 1;

                        if count % 500 == 0 {
                            app.emit("scan-progress", (count, path.to_string_lossy().to_string())).ok();
                        }
                    }
                    Err(e) => errors.push(format!("{}: {}", path.display(), e)),
                }
            }
        }

        app.emit("scan-progress", (count, "Saving to Database...".to_string())).ok();

        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO files 
            (volume_label, base_folder, filename, file_ext, rel_path, size, mtime, scanned_at) 
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).map_err(|e| e.to_string())?;

        let tx = conn.unchecked_transaction().unwrap();
        for f in files_to_insert {
            stmt.execute(params![f.0, f.1, f.2, f.3, f.4, f.5, f.6, f.7]).ok();
        }
        tx.commit().unwrap();

        Ok(ScanResult {
            volume_label,
            base_folder: folder_path,
            total_files: count,
            errors,
        })
    }).await;

    match result {
        Ok(res) => res,
        Err(e) => Err(format!("Background task failed: {}", e)),
    }
}

#[tauri::command]
fn get_folders() -> Result<Vec<(String, String, i64, i64, f64)>, String> {
    let conn = get_db_conn();
    let mut stmt = conn.prepare(
        "SELECT volume_label, base_folder, COUNT(*), SUM(size), MAX(scanned_at) 
         FROM files GROUP BY volume_label, base_folder ORDER BY volume_label, base_folder"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for r in rows { if let Ok(val) = r { result.push(val); } }
    Ok(result)
}

#[tauri::command]
async fn find_duplicates(
    app: tauri::AppHandle, 
    state: State<'_, AppState>
) -> Result<std::collections::HashMap<String, Vec<DupEntry>>, String> {
    state.dup_cancel_flag.store(false, Ordering::Relaxed);
    let cancel_flag = state.dup_cancel_flag.clone();

    let result = async_runtime::spawn_blocking(move || {
        let conn = get_db_conn();

        // Extract only one Query
        let mut stmt = conn
            .prepare(
                "SELECT filename, volume_label, base_folder, rel_path, size, file_ext
                 FROM files
                 WHERE filename IN (
                     SELECT filename FROM files GROUP BY filename HAVING COUNT(DISTINCT volume_label) >= 2
                 )
                 ORDER BY filename",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?, // filename
                    DupEntry {
                        volume_label: row.get(1)?,
                        base_folder: row.get(2)?,
                        rel_path: row.get(3)?,
                        size: row.get(4)?,
                        file_ext: row.get(5)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut res: std::collections::HashMap<String, Vec<DupEntry>> = std::collections::HashMap::new();
        let mut count = 0;

        for row in rows {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Search cancelled by user".to_string());
            }

            if let Ok((filename, entry)) = row {
                res.entry(filename).or_insert_with(Vec::new).push(entry);
                count += 1;
                
                if count % 100 == 0 {
                    app.emit("dup-progress", (count, 0, "Grouping...".to_string())).ok();
                }
            }
        }

        Ok(res)
    }).await;

    match result {
        Ok(res) => res,
        Err(e) => Err(format!("Task failed: {}", e)),
    }
}

#[tauri::command]
fn clear_db(volume_label: Option<String>, base_folder: Option<String>) -> Result<(), String> {
    let conn = get_db_conn();
    if let (Some(v), Some(b)) = (volume_label, base_folder) {
        conn.execute("DELETE FROM files WHERE volume_label = ?1 AND base_folder = ?2", params![v, b]).ok();
    } else {
        conn.execute("DELETE FROM files", []).ok();
    }
    conn.execute("VACUUM", []).ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            scan_cancel_flag: Arc::new(AtomicBool::new(false)),
            dup_cancel_flag: Arc::new(AtomicBool::new(false)),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init()) 
        .invoke_handler(tauri::generate_handler![
            init_db, 
            scan_folder, 
            get_folders, 
            find_duplicates, 
            clear_db, 
            cancel_scan,
            cancel_duplicate_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
