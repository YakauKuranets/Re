import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';
import L from 'leaflet';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';

import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';
let DefaultIcon = L.icon({ iconUrl: icon, shadowUrl: iconShadow, iconSize: [25, 41], iconAnchor: [12, 41] });
L.Marker.prototype.options.icon = DefaultIcon;

function MapController({ center }) {
  const map = useMap();
  useEffect(() => { if (center) map.setView(center, 14); }, [center, map]);
  return null;
}

export default function App() {
  const [targets, setTargets] = useState([]);
  const [activeStream, setActiveStream] = useState(null);
  const [streamType, setStreamType] = useState('hls');
  const [activeTargetId, setActiveTargetId] = useState(null);
  const [activeCameraName, setActiveCameraName] = useState('');

  const [loading, setLoading] = useState(false);
  const [radarStatus, setRadarStatus] = useState('');

  const [addressQuery, setAddressQuery] = useState('');
  const [mapCenter, setMapCenter] = useState([53.9, 27.56]);
  const [form, setForm] = useState({ name: '', host: '', login: 'admin', password: '', lat: 53.9, lng: 27.56, channelCount: 4 });

  const [hubSearch, setHubSearch] = useState('');
  const [hubResults, setHubResults] = useState([]);

  // --- FTP STATES ---
  const [ftpBrowserOpen, setFtpBrowserOpen] = useState(false);
  const [activeServerAlias, setActiveServerAlias] = useState("video1"); // Храним выбранный сервер
  const [ftpPath, setFtpPath] = useState("/"); // Путь теперь начинается от корня сервера
  const [ftpItems, setFtpItems] = useState([]);

  const [shodanResults, setShodanResults] = useState([]);
  const [portScanHost, setPortScanHost] = useState('');
  const [portScanResult, setPortScanResult] = useState([]);
  const [runtimeLogs, setRuntimeLogs] = useState([]);
  const [targetSearch, setTargetSearch] = useState('');
  const [targetTypeFilter, setTargetTypeFilter] = useState('all');
  const [archiveOnly, setArchiveOnly] = useState(false);
  const [downloadTasks, setDownloadTasks] = useState(() => {
    try {
      const raw = localStorage.getItem('hyperion_download_tasks');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [resumeDownloads, setResumeDownloads] = useState(() => {
    try {
      const raw = localStorage.getItem('hyperion_resume_downloads');
      return raw == null ? true : raw === '1';
    } catch {
      return true;
    }
  });
  const [nvrProbeResults, setNvrProbeResults] = useState([]);
  const [nvrDeviceInfo, setNvrDeviceInfo] = useState(null);
  const [isapiSearchResults, setIsapiSearchResults] = useState([]);
  const [isapiFrom, setIsapiFrom] = useState('2026-01-01T00:00:00Z');
  const [isapiTo, setIsapiTo] = useState('2026-12-31T23:59:59Z');
  const [isapiSearchAuth, setIsapiSearchAuth] = useState({ login: 'admin', pass: '' });
  const [onvifDeviceInfo, setOnvifDeviceInfo] = useState(null);
  const [onvifRecordingTokens, setOnvifRecordingTokens] = useState([]);
  const [onvifSearchAuth, setOnvifSearchAuth] = useState({ login: 'admin', pass: '' });
  const [archiveProbeResults, setArchiveProbeResults] = useState([]);
  const [implementationStatus, setImplementationStatus] = useState(null);

  const hubConfig = {
    cookie: "login=mvd; admin=d32e003ac0909010c412e0930b621f8f; PHPSESSID=d8qtnapeqlgrism37hkarq9mk5",
  };

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollIntervalRef = useRef(null);

  useEffect(() => { loadTargets(); }, []);


  useEffect(() => {
    invoke('get_implementation_status')
      .then((status) => setImplementationStatus(status))
      .catch(() => {});
  }, []);


  useEffect(() => {
    try {
      localStorage.setItem('hyperion_resume_downloads', resumeDownloads ? '1' : '0');
    } catch {}
  }, [resumeDownloads]);

  useEffect(() => {
    try {
      localStorage.setItem('hyperion_download_tasks', JSON.stringify(downloadTasks.slice(0, 50)));
    } catch {}
  }, [downloadTasks]);

  useEffect(() => {
    let disposed = false;

    const fetchLogs = async () => {
      try {
        const logs = await invoke('get_runtime_logs', { limit: 200 });
        if (!disposed) {
          setRuntimeLogs(logs);

          const progressLines = logs.filter((line) => line.includes('DOWNLOAD_PROGRESS|'));
          const cancelledLines = logs.filter((line) => line.includes('DOWNLOAD_CANCELLED|'));

          if (progressLines.length > 0 || cancelledLines.length > 0) {
            setDownloadTasks((prev) => {
              let next = [...prev];
              for (const line of progressLines) {
                const raw = line.split('DOWNLOAD_PROGRESS|')[1] || '';
                const [taskId, currentRaw, totalRaw] = raw.split('|');
                const current = Number(currentRaw || 0);
                const total = Number(totalRaw || 0);
                if (!taskId) continue;
                next = next.map((t) => {
                  if (t.id !== taskId) return t;
                  if (t.status === 'done' || t.status === 'cancelled') return t;
                  if (total > 0) {
                    return {
                      ...t,
                      status: 'running',
                      percent: Math.max(1, Math.min(99, Math.round((current / total) * 100))),
                      bytesWritten: current,
                    };
                  }
                  return {
                    ...t,
                    status: 'running',
                    bytesWritten: Math.max(t.bytesWritten || 0, current),
                  };
                });
              }

              for (const line of cancelledLines) {
                const raw = line.split('DOWNLOAD_CANCELLED|')[1] || '';
                const [taskId] = raw.split('|');
                if (!taskId) continue;
                next = next.map((t) =>
                  t.id === taskId ? { ...t, status: 'cancelled', error: 'Отменено пользователем' } : t,
                );
              }

              return next;
            });
          }
        }
      } catch (e) {}
    };

    fetchLogs();
    const timer = setInterval(fetchLogs, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (activeStream && streamType === 'hls' && videoRef.current) {
      if (playerRef.current) { playerRef.current.dispose(); }
      const player = videojs(videoRef.current, {
        autoplay: true, controls: true, responsive: true, fluid: true, liveui: true,
        sources: [{ src: activeStream, type: 'application/x-mpegURL' }],
        html5: { vhs: { overrideNative: true, fastQualityChange: true } }
      });
      playerRef.current = player;
    }
    return () => { if (playerRef.current) { playerRef.current.dispose(); playerRef.current = null; } };
  }, [activeStream, streamType]);

  const loadTargets = async () => {
    try {
      const keys = await invoke('get_all_targets');
      const loaded = [];
      for (let key of keys) {
        const jsonStr = await invoke('read_target', { targetId: key });
        loaded.push(JSON.parse(jsonStr));
      }
      setTargets(loaded);
    } catch (err) { console.error(err); }
  };

  const handleSmartSave = async () => {
    if (!form.host) return alert("Требуется IP");
    const autoId = `nvr_${Date.now()}`;
    const channels = Array.from({length: form.channelCount}, (_, i) => ({ id: `ch${i+1}`, index: i+1, name: `Камера ${i+1}` }));
    const payload = JSON.stringify({ ...form, id: autoId, channels });
    await invoke('save_target', { targetId: autoId, payload });
    loadTargets();
  };

  const handleDeleteTarget = async (id) => {
    if (window.confirm(`Ликвидировать досье?`)) {
      await invoke('delete_target', { targetId: id });
      loadTargets();
    }
  };

  const handleGeocode = async () => {
    try {
      const [lat, lng] = await invoke('geocode_address', { address: addressQuery });
      setForm({ ...form, lat, lng }); setMapCenter([lat, lng]);
    } catch (err) { alert("Не найдено"); }
  };

  const handleStartStream = async (terminal, channel) => {
    try {
      if (activeTargetId) {
        await invoke('stop_stream', { targetId: activeTargetId });
      }
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

      setLoading(true);
      let streamSessionId = '';

      if (terminal.type === 'hub') {
        setRadarStatus('ЗАПУСК FFMPEG-ТУННЕЛЯ ДЛЯ ХАБА...');
        streamSessionId = `hub_${terminal.hub_id}_${channel.index}`;
        await invoke('start_hub_stream', {
            targetId: streamSessionId,
            userId: terminal.hub_id.toString(),
            channelId: channel.index.toString(),
            cookie: hubConfig.cookie
        });
      } else {
        setRadarStatus('РАЗВЕДКА МАРШРУТА...');
        let cleanHost = terminal.host.replace(/^(http:\/\/|https:\/\/|rtsp:\/\/)/i, '').split('/')[0];
        const activePath = await invoke('probe_rtsp_path', { host: cleanHost, login: terminal.login, pass: terminal.password });
        const safePath = activePath.replace(/channel=1|ch1|Channels\/1/g, (match) => match.replace('1', channel.index));
        const rtspUrl = `rtsp://${terminal.login}:${terminal.password}@${cleanHost}/${safePath.replace(/^\//, '')}`;

        streamSessionId = `${terminal.id}_${channel.id}`;
        setRadarStatus('ЗАПУСК ЯДРА FFMPEG...');
        await invoke('start_stream', { targetId: streamSessionId, rtspUrl });
      }

      let attempts = 0;
      const streamUrl = `http://127.0.0.1:49152/${streamSessionId}/stream.m3u8`;

      pollIntervalRef.current = setInterval(async () => {
        attempts++;
        setRadarStatus(`ПОИСК ПАКЕТОВ... ПОПЫТКА ${attempts}/15`);
        try {
          const res = await fetch(`${streamUrl}?ping=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
          if (res.ok) {
            clearInterval(pollIntervalRef.current);
            setStreamType('hls');
            setActiveStream(`${streamUrl}?t=${Date.now()}`);
            setActiveTargetId(streamSessionId);
            setActiveCameraName(`${terminal.name} :: ${channel.name}`);
            setLoading(false);
          }
        } catch (e) {}

        if (attempts >= 15) {
          clearInterval(pollIntervalRef.current);
          setRadarStatus('ТАЙМАУТ: ЦЕЛЬ НЕ ОТВЕЧАЕТ');
          setTimeout(() => { setLoading(false); }, 2000);
          await invoke('stop_stream', { targetId: streamSessionId });
        }
      }, 1000);
    } catch (err) {
      alert("СБОЙ: " + err);
      setLoading(false);
    }
  };

  const handleStopStream = async () => {
    if (activeTargetId) {
      await invoke('stop_stream', { targetId: activeTargetId });
    }
    setActiveTargetId(null);
    setActiveStream(null);
    setActiveCameraName('');
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  };

  const handleHubSearch = async () => {
    try {
        setLoading(true);
        setRadarStatus('СКАНИРОВАНИЕ БАЗЫ ХАБА...');
        const res = await invoke('search_global_hub', { query: hubSearch, cookie: hubConfig.cookie });
        if (res.length === 0) alert("Поиск не дал результатов. Проверьте адрес или обновите PHPSESSID в коде!");
        setHubResults(res);
        setLoading(false);
    } catch (err) {
        alert("ОШИБКА РАЗВЕДКИ: " + err);
        setLoading(false);
    }
  };

  const handleHubStream = (userId, channelId, address) => {
      const fakeTerminal = { type: 'hub', hub_id: userId, name: `GLOBAL HUB :: ${address}` };
      const fakeChannel = { index: channelId, name: `Камера ${parseInt(channelId) + 1}` };
      handleStartStream(fakeTerminal, fakeChannel);
  };

  // --- ОБНОВЛЕННАЯ ФУНКЦИЯ ДЛЯ FTP ---
  const fetchFtpRoot = async (serverAlias) => {
    setLoading(true);
    setRadarStatus(`СОЕДИНЕНИЕ С АРХИВОМ: ${serverAlias.toUpperCase()}...`);
    try {
        // Вызываем нашу новую команду на Rust
        const folders = await invoke('get_ftp_folders', { serverAlias });

        setActiveServerAlias(serverAlias);
        setFtpPath("/");
        setFtpItems(folders); // Сохраняем полученные объекты {name, path}
        setFtpBrowserOpen(true);
    } catch (err) {
        alert(`Ошибка FTP-сервера.\nСервер: ${serverAlias}\nОтвет сервера: ${err}`);
    } finally {
        setLoading(false);
    }
  };

  // --- ФУНКЦИЯ СКАЧИВАНИЯ ---
  const handleDownloadFtp = async (serverAlias, folderPath, filename) => {
    const taskId = `${serverAlias}_${filename}_${Date.now()}`;
    setDownloadTasks(prev => ([
      {
        id: taskId,
        filename,
        serverAlias,
        folderPath,
        status: 'running',
        percent: null,
        bytesWritten: 0,
        speedBytesSec: 0,
      },
      ...prev.slice(0, 19),
    ]));

    setLoading(true);
    setRadarStatus(`СКАЧИВАНИЕ ФАЙЛА: ${filename}...`);
    try {
        const report = await invoke('download_ftp_file', {
            serverAlias,
            folderPath,
            filename,
            resumeIfExists: resumeDownloads,
            taskId,
        });

        const durationSec = Math.max((report.durationMs || 0) / 1000, 0.001);
        const speedBytesSec = Math.round((report.bytesWritten || 0) / durationSec);

        setDownloadTasks(prev => prev.map(t =>
          t.id === taskId
            ? {
                ...t,
                status: 'done',
                percent: 100,
                bytesWritten: report.totalBytes || report.bytesWritten || 0,
                speedBytesSec,
                savePath: report.savePath,
                resumed: !!report.resumed,
                skipped: !!report.skippedAsComplete,
              }
            : t,
        ));

        const resumeNote = report.skippedAsComplete
          ? ' (уже был полностью скачан)'
          : report.resumed
            ? ' (докачка выполнена)'
            : '';
        alert(`Файл ${filename} успешно скачан${resumeNote} в ${report.savePath || `D:\\Nemesis_Vault\\recon_db\\archives\\${serverAlias}\\`}`);
    } catch (err) {
        setDownloadTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: 'error', percent: 0, error: String(err) } : t,
        ));
        alert(`Ошибка скачивания: ${err}`);
    } finally {
        setLoading(false);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx++;
    }
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  };

  const handleRetryDownloadTask = async (task) => {
    if (!task?.serverAlias || !task?.filename) return;
    await handleDownloadFtp(task.serverAlias, task.folderPath || '/', task.filename);
  };

  const handleCancelDownloadTask = async (task) => {
    if (!task?.id || task.status !== 'running') return;
    try {
      await invoke('cancel_download_task', { taskId: task.id });
      setDownloadTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, status: 'cancelled', error: 'Отменено пользователем' } : t,
      ));
    } catch (err) {
      alert(`Ошибка отмены загрузки: ${err}`);
    }
  };

  const clearFinishedDownloads = () => {
    setDownloadTasks(prev => prev.filter(t => t.status === 'running'));
  };

  const handleSaveHubToLocal = async (cam) => {
    const lat = mapCenter[0];
    const lng = mapCenter[1];
    const autoId = `hub_${cam.id}_${Date.now()}`;
    const channels = cam.channels.map(ch => ({ id: `ch${ch}`, index: ch, name: `Камера ${parseInt(ch) + 1}` }));
    const payload = JSON.stringify({
      id: autoId, name: `ХАБ: ${cam.ip}`, host: `videodvor.by_user${cam.id}`, hub_id: cam.id, type: 'hub', lat: lat, lng: lng, channels: channels
    });
    await invoke('save_target', { targetId: autoId, payload });
    loadTargets();
  };

  const handleLocalArchive = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ПРОВЕРКА ПРОТОКОЛОВ NVR: ${terminal.host}`);
    try {
      const probes = await invoke('probe_nvr_protocols', {
        host: terminal.host,
        login: terminal.login || 'admin',
        pass: terminal.password || '',
      });

      setNvrProbeResults(probes);
      const detected = probes.filter(p => p.status === 'detected').length;
      alert(`ПРОВЕРКА NVR (${terminal.host})\n\nНайдено подтвержденных endpoint: ${detected} из ${probes.length}.\nДетали доступны в панели "NVR PROBE".`);
    } catch (err) {
      alert(`Ошибка проверки протоколов: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFetchNvrDeviceInfo = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ISAPI DEVICE INFO: ${terminal.host}`);
    try {
      const info = await invoke('fetch_nvr_device_info', {
        host: terminal.host,
        login: terminal.login || 'admin',
        pass: terminal.password || '',
      });
      setNvrDeviceInfo(info);
    } catch (err) {
      alert(`Ошибка ISAPI deviceInfo: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchIsapiRecordings = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ISAPI SEARCH: ${terminal.host}`);
    try {
      const login = terminal.login || 'admin';
      const pass = terminal.password || '';
      const result = await invoke('search_isapi_recordings', {
        host: terminal.host,
        login,
        pass,
        fromTime: isapiFrom,
        toTime: isapiTo,
      });
      setIsapiSearchAuth({ login, pass });
      setIsapiSearchResults(result);
      alert(`ISAPI search (${terminal.host})
Найдено записей: ${result.length}`);
    } catch (err) {
      alert(`Ошибка ISAPI search: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFetchOnvifDeviceInfo = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ONVIF DEVICE INFO: ${terminal.host}`);
    try {
      const info = await invoke('fetch_onvif_device_info', {
        host: terminal.host,
        login: terminal.login || 'admin',
        pass: terminal.password || '',
      });
      setOnvifDeviceInfo(info);
    } catch (err) {
      alert(`Ошибка ONVIF deviceInfo: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadIsapiPlayback = async (item) => {
    if (!item?.playbackUri) {
      return alert('Для этой записи отсутствует playback URI');
    }

    const taskId = `isapi_${Date.now()}`;
    setDownloadTasks(prev => ([
      {
        id: taskId,
        filename: item.playbackUri.split('/').pop() || 'isapi_record.mp4',
        serverAlias: 'isapi',
        folderPath: '/isapi',
        status: 'running',
        percent: null,
        bytesWritten: 0,
        speedBytesSec: 0,
      },
      ...prev.slice(0, 19),
    ]));

    setLoading(true);
    setRadarStatus('ISAPI DOWNLOAD...');
    try {
      const report = await invoke('download_isapi_playback_uri', {
        playbackUri: item.playbackUri,
        login: isapiSearchAuth.login || 'admin',
        pass: isapiSearchAuth.pass || '',
        filenameHint: item.playbackUri.split('/').pop() || 'isapi_record.mp4',
        taskId,
      });

      const durationSec = Math.max((report.durationMs || 0) / 1000, 0.001);
      const speedBytesSec = Math.round((report.bytesWritten || 0) / durationSec);
      setDownloadTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, status: 'done', percent: 100, bytesWritten: report.totalBytes || report.bytesWritten || 0, speedBytesSec, savePath: report.savePath }
          : t,
      ));
    } catch (err) {
      setDownloadTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: 'error', percent: 0, error: String(err) } : t,
      ));
      alert(`Ошибка ISAPI download: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchOnvifRecordings = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ONVIF RECORDINGS SEARCH: ${terminal.host}`);
    try {
      const login = terminal.login || 'admin';
      const pass = terminal.password || '';
      const result = await invoke('search_onvif_recordings', {
        host: terminal.host,
        login,
        pass,
      });
      setOnvifRecordingTokens(result);
      setOnvifSearchAuth({ login, pass });
      alert(`ONVIF recordings (${terminal.host})
Найдено токенов: ${result.length}`);
    } catch (err) {
      alert(`Ошибка ONVIF recordings search: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadOnvifToken = async (item) => {
    if (!item?.token || !item?.endpoint) return;

    const taskId = `onvif_${Date.now()}`;
    setDownloadTasks(prev => ([
      {
        id: taskId,
        filename: `onvif_${item.token}.mp4`,
        serverAlias: 'onvif',
        folderPath: '/onvif',
        status: 'running',
        percent: null,
        bytesWritten: 0,
        speedBytesSec: 0,
      },
      ...prev.slice(0, 19),
    ]));

    setLoading(true);
    setRadarStatus('ONVIF DOWNLOAD...');
    try {
      const report = await invoke('download_onvif_recording_token', {
        endpoint: item.endpoint,
        recordingToken: item.token,
        login: onvifSearchAuth.login || 'admin',
        pass: onvifSearchAuth.pass || '',
        filenameHint: `onvif_${item.token}.mp4`,
        taskId,
      });

      const durationSec = Math.max((report.durationMs || 0) / 1000, 0.001);
      const speedBytesSec = Math.round((report.bytesWritten || 0) / durationSec);
      setDownloadTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, status: 'done', percent: 100, bytesWritten: report.totalBytes || report.bytesWritten || 0, speedBytesSec, savePath: report.savePath }
          : t,
      ));
    } catch (err) {
      setDownloadTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: 'error', percent: 0, error: String(err) } : t,
      ));
      alert(`Ошибка ONVIF download: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleProbeArchiveExport = async (terminal) => {
    setLoading(true);
    setRadarStatus(`ARCHIVE EXPORT PROBE: ${terminal.host}`);
    try {
      const result = await invoke('probe_archive_export_endpoints', {
        host: terminal.host,
        login: terminal.login || 'admin',
        pass: terminal.password || '',
      });
      setArchiveProbeResults(result);
      const detected = result.filter((x) => x.status === 'detected').length;
      alert(`ПРОВЕРКА EXPORT-ENDPOINT (${terminal.host})

Найдено потенциальных endpoint: ${detected} из ${result.length}.`);
    } catch (err) {
      alert(`Ошибка проверки export-endpoint: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const filteredTargets = targets.filter((t) => {
    const q = targetSearch.trim().toLowerCase();
    const byQuery = !q || `${t.name || ''} ${t.host || ''}`.toLowerCase().includes(q);
    const byType = targetTypeFilter === 'all' || (targetTypeFilter === 'hub' ? t.type === 'hub' : t.type !== 'hub');
    const byArchive = !archiveOnly || t.type === 'hub';
    return byQuery && byType && byArchive;
  });

  const handlePortScan = async () => {
    const host = portScanHost.trim();
    if (!host) return alert('Укажите host/IP для сканирования');

    setLoading(true);
    setRadarStatus(`АНАЛИЗ УЗЛА ${host}...`);
    try {
      const result = await invoke('scan_host_ports', { host });
      setPortScanResult(result);
    } catch (err) {
      alert(`Ошибка сканирования: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0a0a0c', color: '#fff', fontFamily: 'monospace' }}>

      {loading && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#00f0ff' }}>
          <div style={{ fontSize: '24px', letterSpacing: '5px', marginBottom: '20px' }}>[ ОБРАБОТКА ДАННЫХ ]</div>
          <div style={{ fontSize: '14px', color: '#ff003c' }}>{radarStatus}</div>
        </div>
      )}

      {/* --- ОБНОВЛЕННЫЙ FTP-ПРОВОДНИК --- */}
      {ftpBrowserOpen && (
        <div style={{ position: 'fixed', top: '5%', left: '5%', width: '90%', height: '90%', backgroundColor: '#05050a', border: '2px solid #00f0ff', zIndex: 10000, padding: '20px', display: 'flex', flexDirection: 'column', boxShadow: '0 0 30px #00f0ff44', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h2 style={{ color: '#00f0ff', margin: 0 }}>📁 СЕРВЕР АРХИВОВ NVR ({activeServerAlias.toUpperCase()})</h2>
            <button onClick={() => setFtpBrowserOpen(false)} style={{ background: 'none', border: '1px solid #ff003c', color: '#ff003c', cursor: 'pointer', fontWeight: 'bold', padding: '5px 15px' }}>ЗАКРЫТЬ [X]</button>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
            {/* Кнопки переключения серверов */}
            <button onClick={() => fetchFtpRoot('video1')} style={{ background: activeServerAlias === 'video1' ? '#1a4a4a' : '#111', color: '#00f0ff', border: '1px solid #00f0ff', padding: '5px 15px', cursor: 'pointer' }}>SERVER 1 (video1)</button>
            <button onClick={() => fetchFtpRoot('video2')} style={{ background: activeServerAlias === 'video2' ? '#4a1a4a' : '#111', color: '#ff00ff', border: '1px solid #ff00ff', padding: '5px 15px', cursor: 'pointer' }}>SERVER 2 (video2)</button>

            <div style={{ flex: 1, background: '#000', color: '#fff', border: '1px solid #555', padding: '8px', fontSize: '14px', display: 'flex', alignItems: 'center' }}>
                <span style={{color: '#888', marginRight: '5px'}}>ПУТЬ:</span> {ftpPath}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #333', background: '#000', padding: '10px' }}>
            {ftpItems.map((item, index) => {
                // Если мы кликаем по видео-файлу, в будущем здесь можно будет сделать переход внутрь папки, если нужно
                // Пока мы отображаем то, что вернул Rust (в корне лежат только папки)
                return (
                    <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', borderBottom: '1px solid #111', cursor: 'default' }}>
                        <span style={{ color: '#00f0ff', fontSize: '14px' }}>
                            📁 {item.name}
                        </span>

                        {/* Кнопка скачивания. Так как в корне лежат папки (архивы), мы передаем путь и имя */}
                        {/* ВАЖНО: Тебе нужно решить, ты качаешь папку целиком или файл внутри. Сейчас код в Rust рассчитан на скачивание ОДНОГО файла. */}
                        {/* Если эти папки - это архивы (zip, tar, mp4), то кнопка сработает. Если это реальные директории, в Rust нужно будет дописать логику скачивания директории целиком. */}
                        <button onClick={(e) => { e.stopPropagation(); handleDownloadFtp(activeServerAlias, "/", item.name); }} style={{ background: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', cursor: 'pointer', padding: '5px 15px', fontWeight: 'bold' }}>СКАЧАТЬ АРХИВ</button>
                    </div>
                );
            })}
            {ftpItems.length === 0 && <div style={{ color: '#555', textAlign: 'center', marginTop: '20px' }}>Директория пуста</div>}
          </div>
        </div>
      )}

      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer center={mapCenter} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
          <MapController center={mapCenter} />
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

          {filteredTargets.map(t => (
            <Marker key={t.id} position={[t.lat, t.lng]}>
              <Popup>
                <div style={{ color: '#000', minWidth: '150px' }}>
                  <strong>{t.name}</strong><br/>
                  <div style={{ marginTop: '8px' }}>
                    {t.channels?.map(ch => (
                      <button key={ch.id} onClick={() => handleStartStream(t, ch)} style={{ display: 'block', width: '100%', marginBottom: '4px', padding: '6px', cursor: 'pointer', backgroundColor: '#111', color: '#00f0ff', border: '1px solid #00f0ff', fontSize: '11px' }}>
                        ▶ ПЕРЕХВАТ: {ch.name}
                      </button>
                    ))}

                    {t.type === 'hub' ? (
                        <button onClick={() => fetchFtpRoot('video1')} style={{ display: 'block', width: '100%', marginTop: '8px', padding: '6px', cursor: 'pointer', backgroundColor: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', fontSize: '11px', fontWeight: 'bold' }}>
                          📁 АРХИВ ХАБА (FTP)
                        </button>
                    ) : (
                        <>
                          <button onClick={() => handleLocalArchive(t)} style={{ display: 'block', width: '100%', marginTop: '8px', padding: '6px', cursor: 'pointer', backgroundColor: '#4a1a1a', color: '#ff9900', border: '1px solid #ff9900', fontSize: '11px', fontWeight: 'bold' }}>
                            ⏳ ЗАПРОС ПАМЯТИ
                          </button>
                          <button onClick={() => handleFetchNvrDeviceInfo(t)} style={{ display: 'block', width: '100%', marginTop: '6px', padding: '6px', cursor: 'pointer', backgroundColor: '#1a1a4a', color: '#9fc2ff', border: '1px solid #6a88ff', fontSize: '11px', fontWeight: 'bold' }}>
                            ℹ ISAPI DEVICE INFO
                          </button>
                          <button onClick={() => handleFetchOnvifDeviceInfo(t)} style={{ display: 'block', width: '100%', marginTop: '6px', padding: '6px', cursor: 'pointer', backgroundColor: '#1a3a1a', color: '#a8ffb0', border: '1px solid #47c45a', fontSize: '11px', fontWeight: 'bold' }}>
                            ℹ ONVIF DEVICE INFO
                          </button>
                        </>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {activeStream && (
          <div style={{ position: 'absolute', bottom: 20, left: 20, width: '520px', border: '2px solid #00f0ff', zIndex: 1000, backgroundColor: '#000', boxShadow: '0 0 20px rgba(0,240,255,0.3)' }}>
            <div style={{ background: '#00f0ff', color: '#000', padding: '5px', fontSize: '12px', display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
              <span>LIVE: {activeCameraName}</span>
              <span onClick={handleStopStream} style={{ cursor: 'pointer' }}>[ ЗАКРЫТЬ ]</span>
            </div>

            <div data-vjs-player>
              <video ref={videoRef} className="video-js vjs-big-play-centered" />
            </div>
          </div>
        )}
      </div>

      <div style={{ width: '400px', backgroundColor: '#111115', borderLeft: '2px solid #ff003c', padding: '20px', overflowY: 'auto' }}>
        <h2 style={{ color: '#ff003c', fontSize: '1.2rem', marginBottom: '20px' }}>HYPERION NODE</h2>

        <div style={{ border: '1px solid #2f9a4f', padding: '10px', backgroundColor: '#07130b', marginBottom: '20px' }}>
          <h3 style={{ color: '#7dff9c', marginTop: '0', fontSize: '0.9rem' }}>📌 СТАТУС РЕАЛИЗАЦИИ</h3>
          {implementationStatus ? (
            <>
              <div style={{ color: '#c9ffd6', fontSize: '12px', marginBottom: '8px' }}>
                Выполнено: <b>{implementationStatus.completed}/{implementationStatus.total}</b> · В работе: <b>{implementationStatus.in_progress}</b> · Осталось: <b>{implementationStatus.left}</b>
              </div>
              <div style={{ maxHeight: '120px', overflowY: 'auto', border: '1px solid #15361f', padding: '6px', background: '#020a05' }}>
                {(implementationStatus.items || []).map((item, idx) => (
                  <div key={`${item.name}_${idx}`} style={{ color: '#8ed9a2', fontSize: '11px', marginBottom: '4px' }}>
                    {item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🛠️' : '⏳'} {item.name}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ color: '#7aa887', fontSize: '11px' }}>Загрузка статуса...</div>
          )}
        </div>

        <div style={{ border: '1px solid #00f0ff', padding: '10px', backgroundColor: '#001a1a', marginBottom: '20px' }}>
          <h3 style={{ color: '#00f0ff', marginTop: '0', fontSize: '0.9rem' }}>🌐 SHODAN API SCANNER</h3>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
            <button
              onClick={async () => {
                setLoading(true); setRadarStatus('ЗАПРОС К СЕРВЕРАМ SHODAN...');
                try { setShodanResults(await invoke('shodan_search', { country: 'BY', city: 'Minsk' })); }
                catch (err) { alert(err); }
                setLoading(false);
              }}
              style={{ flex: 1, backgroundColor: '#00f0ff', color: '#000', border: 'none', padding: '10px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              🕷️ ЗАПУСТИТЬ СБОР ДАННЫХ
            </button>
          </div>
          <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {shodanResults.map(dev => (
              <div key={dev.id} style={{ border: '1px solid #00f0ff', padding: '8px', marginBottom: '5px', background: '#001111' }}>
                <div style={{ color: '#00f0ff', fontSize: '11px', fontWeight: 'bold' }}>IP: {dev.ip}</div>
                <div style={{ color: '#888', fontSize: '10px' }}>{dev.status}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ border: '1px solid #ff003c', padding: '10px', backgroundColor: '#1a0505', marginBottom: '20px' }}>
          <h3 style={{ color: '#ff003c', marginTop: '0', fontSize: '0.9rem' }}>GLOBAL HUB: MVD LINK</h3>
          <div style={{ display: 'flex', marginBottom: '10px' }}>
              <input style={{ flex: 1, backgroundColor: '#000', border: '1px solid #ff003c', color: '#ff003c', padding: '8px' }} placeholder="Улица, дом..." value={hubSearch} onChange={e => setHubSearch(e.target.value)} />
              <button style={{ backgroundColor: '#ff003c', color: '#fff', border: 'none', padding: '8px', cursor: 'pointer', fontWeight: 'bold' }} onClick={handleHubSearch}>СКАН</button>
          </div>

          {hubResults.map(cam => (
              <div key={cam.id} style={{ border: '1px solid #444', padding: '10px', marginBottom: '8px', backgroundColor: '#050505' }}>
                  <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '12px', marginBottom: '5px' }}>{cam.ip}</div>
                  <div style={{ fontSize: '10px', color: '#888', marginBottom: '8px' }}>USER ID: {cam.id} | Камер: {cam.channels.length}</div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
                      {cam.channels.map(ch => (
                          <button key={ch} onClick={() => handleHubStream(cam.id, ch, cam.ip)} style={{ backgroundColor: '#00f0ff', color: '#000', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold' }}>
                            LIVE: К-{parseInt(ch) + 1}
                          </button>
                      ))}
                  </div>

                  <div style={{ display: 'flex', gap: '5px' }}>
                      {/* ОБНОВЛЕННАЯ КНОПКА ОТКРЫТИЯ FTP ИЗ ПРАВОЙ ПАНЕЛИ */}
                      <button onClick={() => fetchFtpRoot('video1')} style={{ flex: 1, backgroundColor: '#1a4a4a', color: '#00f0ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                        📁 АРХИВ (FTP)
                      </button>

                      <button onClick={() => handleSaveHubToLocal(cam)} style={{ flex: 1, backgroundColor: '#4a1a4a', color: '#ff00ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                        📌 В БАЗУ
                      </button>
                  </div>
              </div>
          ))}
        </div>



        <hr style={{ borderColor: '#222' }} />

        <div style={{ marginTop: '20px' }}>
          <h3 style={{ color: '#00f0ff', fontSize: '0.9rem', marginBottom: '10px' }}>АВТО-ОПРЕДЕЛЕНИЕ СЕРВИСОВ (ПОРТЫ)</h3>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
            <input
              style={{ flex: 1, backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', boxSizing: 'border-box' }}
              placeholder='IP/Host (пример: 192.168.1.100)'
              value={portScanHost}
              onChange={e => setPortScanHost(e.target.value)}
            />
            <button onClick={handlePortScan} style={{ backgroundColor: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', cursor: 'pointer', padding: '0 12px', fontWeight: 'bold' }}>СКАН</button>
          </div>

          {portScanResult.length > 0 && (
            <div style={{ border: '1px solid #222', background: '#050505' }}>
              {portScanResult.map((item) => (
                <div key={item.port} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid #111', fontSize: '11px' }}>
                  <span style={{ color: '#aaa' }}>{item.port} / {item.service}</span>
                  <span style={{ color: item.open ? '#00ff9c' : '#ff5555', fontWeight: 'bold' }}>{item.open ? 'OPEN' : 'CLOSED'}</span>
                </div>
              ))}
            </div>
          )}
        </div>


        <hr style={{ borderColor: '#222' }} />

        <div style={{ marginTop: '20px' }}>
          <h3 style={{ color: '#00f0ff', fontSize: '0.9rem', marginBottom: '10px' }}>NVR PROBE (ISAPI/ONVIF)</h3>
          <div style={{ border: '1px solid #222', background: '#050505', maxHeight: '180px', overflowY: 'auto', padding: '8px' }}>
            {nvrProbeResults.length === 0 && (
              <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «⏳ ЗАПРОС ПАМЯТИ» у локальной цели.</div>
            )}
            {nvrProbeResults.map((r, idx) => (
              <div key={`${r.protocol}_${r.endpoint}_${idx}`} style={{ borderBottom: '1px solid #111', padding: '6px 0' }}>
                <div style={{ fontSize: '10px', color: '#bbb' }}>{r.protocol}</div>
                <div style={{ fontSize: '10px', color: '#777', wordBreak: 'break-all' }}>{r.endpoint}</div>
                <div style={{ fontSize: '10px', color: r.status === 'detected' ? '#00ff9c' : r.status === 'not_detected' ? '#ffcc66' : '#ff5555' }}>{r.status}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <h3 style={{ color: '#00f0ff', fontSize: '0.85rem', marginBottom: '8px' }}>ISAPI DEVICE INFO</h3>
          <div style={{ border: '1px solid #222', background: '#050505', maxHeight: '160px', overflowY: 'auto', padding: '8px' }}>
            {!nvrDeviceInfo && <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «ℹ ISAPI DEVICE INFO» у локальной цели.</div>}
            {nvrDeviceInfo && (
              <>
                <div style={{ color: '#aaa', fontSize: '10px', marginBottom: '6px', wordBreak: 'break-all' }}>{nvrDeviceInfo.endpoint} [{nvrDeviceInfo.status}]</div>
                <pre style={{ margin: 0, color: '#9fc2ff', fontSize: '10px', whiteSpace: 'pre-wrap' }}>{nvrDeviceInfo.bodyPreview || 'empty'}</pre>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <h3 style={{ color: '#9fd7ff', fontSize: '0.85rem', marginBottom: '8px' }}>ISAPI SEARCH RESULTS</h3>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <input value={isapiFrom} onChange={(e) => setIsapiFrom(e.target.value)} style={{ flex: 1, background: '#000', color: '#9fd7ff', border: '1px solid #1f2d4a', padding: '4px', fontSize: '10px' }} placeholder='from' />
            <input value={isapiTo} onChange={(e) => setIsapiTo(e.target.value)} style={{ flex: 1, background: '#000', color: '#9fd7ff', border: '1px solid #1f2d4a', padding: '4px', fontSize: '10px' }} placeholder='to' />
          </div>
          <div style={{ border: '1px solid #1f2d4a', background: '#05070b', maxHeight: '160px', overflowY: 'auto', padding: '8px' }}>
            {isapiSearchResults.length === 0 && <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «🔎 ISAPI SEARCH RECORDS» у локальной цели.</div>}
            {isapiSearchResults.map((item, idx) => (
              <div key={`${item.endpoint}_${idx}`} style={{ borderBottom: '1px solid #111', padding: '6px 0', fontSize: '10px' }}>
                <div style={{ color: '#90b8d8', wordBreak: 'break-all' }}>{item.endpoint}</div>
                <div style={{ color: '#7fa9cb' }}>track: {item.trackId || '-'}</div>
                <div style={{ color: '#7fa9cb' }}>start: {item.startTime || '-'}</div>
                <div style={{ color: '#7fa9cb' }}>end: {item.endTime || '-'}</div>
                <div style={{ color: '#9fd7ff', wordBreak: 'break-all' }}>uri: {item.playbackUri || '-'}</div>
                {item.playbackUri && (
                  <button onClick={() => handleDownloadIsapiPlayback(item)} style={{ marginTop: '6px', background: '#1f3a2a', color: '#9fffc5', border: '1px solid #38a169', padding: '3px 6px', cursor: 'pointer', fontSize: '10px' }}>
                    ⬇ DOWNLOAD BY URI
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <h3 style={{ color: '#00f0ff', fontSize: '0.85rem', marginBottom: '8px' }}>ONVIF DEVICE INFO</h3>
          <div style={{ border: '1px solid #222', background: '#050505', maxHeight: '160px', overflowY: 'auto', padding: '8px' }}>
            {!onvifDeviceInfo && <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «ℹ ONVIF DEVICE INFO» у локальной цели.</div>}
            {onvifDeviceInfo && (
              <>
                <div style={{ color: '#aaa', fontSize: '10px', marginBottom: '6px', wordBreak: 'break-all' }}>{onvifDeviceInfo.endpoint} [{onvifDeviceInfo.status}]</div>
                <pre style={{ margin: 0, color: '#a8ffb0', fontSize: '10px', whiteSpace: 'pre-wrap' }}>{onvifDeviceInfo.bodyPreview || 'empty'}</pre>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <h3 style={{ color: '#b9ffcf', fontSize: '0.85rem', marginBottom: '8px' }}>ONVIF RECORDING TOKENS</h3>
          <div style={{ border: '1px solid #2a5a36', background: '#050b06', maxHeight: '130px', overflowY: 'auto', padding: '8px' }}>
            {onvifRecordingTokens.length === 0 && <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «🔎 ONVIF RECORDINGS» у локальной цели.</div>}
            {onvifRecordingTokens.map((item, idx) => (
              <div key={`${item.endpoint}_${item.token}_${idx}`} style={{ borderBottom: '1px solid #132418', padding: '6px 0' }}>
                <div style={{ color: '#88c89b', fontSize: '10px', wordBreak: 'break-all' }}>{item.endpoint}</div>
                <div style={{ color: '#b9ffcf', fontSize: '10px' }}>token: {item.token}</div>
                <button onClick={() => handleDownloadOnvifToken(item)} style={{ marginTop: '6px', background: '#1f3a2a', color: '#b9ffcf', border: '1px solid #38a169', padding: '3px 6px', cursor: 'pointer', fontSize: '10px' }}>
                  ⬇ DOWNLOAD TOKEN
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <h3 style={{ color: '#ffd27a', fontSize: '0.85rem', marginBottom: '8px' }}>ARCHIVE EXPORT ENDPOINTS</h3>
          <div style={{ border: '1px solid #3a2a1a', background: '#0b0805', maxHeight: '160px', overflowY: 'auto', padding: '8px' }}>
            {archiveProbeResults.length === 0 && <div style={{ color: '#666', fontSize: '11px' }}>Нет данных. Нажми «📦 PROBE EXPORT ENDPOINTS» у локальной цели.</div>}
            {archiveProbeResults.map((item, idx) => (
              <div key={`${item.endpoint}_${idx}`} style={{ borderBottom: '1px solid #22180f', padding: '6px 0' }}>
                <div style={{ fontSize: '10px', color: '#e9cda1' }}>{item.protocol} · {item.method}</div>
                <div style={{ fontSize: '10px', color: '#777', wordBreak: 'break-all' }}>{item.endpoint}</div>
                <div style={{ fontSize: '10px', color: item.status === 'detected' ? '#7dff9c' : item.status === 'not_detected' ? '#ffcc66' : '#ff5555' }}>
                  {item.status}{item.statusCode ? ` (HTTP ${item.statusCode})` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        <hr style={{ borderColor: '#222' }} />

        <div style={{ marginTop: '20px' }}>
          <h3 style={{ color: '#00f0ff', fontSize: '0.9rem', marginBottom: '10px' }}>РЕГИСТРАЦИЯ ЛОКАЛЬНОГО УЗЛА</h3>
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px', boxSizing: 'border-box' }} placeholder="Имя узла" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px', boxSizing: 'border-box' }} placeholder="IP (напр. 93.125.3.58:554)" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px', boxSizing: 'border-box' }} placeholder="Логин" value={form.login} onChange={e => setForm({ ...form, login: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px', boxSizing: 'border-box' }} type="password" placeholder="Пароль" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '15px', boxSizing: 'border-box' }} type="number" placeholder="Каналы" value={form.channelCount} onChange={e => setForm({ ...form, channelCount: e.target.value })} />

          <div style={{ display: 'flex', gap: '5px', marginBottom: '15px' }}>
            <input style={{ flex: 1, backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', boxSizing: 'border-box' }} placeholder="Координаты" value={addressQuery} onChange={e => setAddressQuery(e.target.value)} />
            <button style={{ backgroundColor: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', cursor: 'pointer', padding: '0 15px' }} onClick={handleGeocode}>GEO</button>
          </div>

          <button style={{ width: '100%', padding: '12px', backgroundColor: '#00f0ff', color: '#000', fontWeight: 'bold', cursor: 'pointer', border: 'none', boxSizing: 'border-box' }} onClick={handleSmartSave}>ENCRYPT DATA</button>
        </div>

        <h3 style={{ color: '#00f0ff', marginTop: '40px', fontSize: '0.9rem' }}>БАЗА ЦЕЛЕЙ</h3>
        <div style={{ border: '1px solid #222', background: '#050505', padding: '8px', marginBottom: '10px' }}>
          <input
            style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '8px', marginBottom: '6px', boxSizing: 'border-box' }}
            placeholder='Поиск по имени/IP'
            value={targetSearch}
            onChange={e => setTargetSearch(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <button onClick={() => setTargetTypeFilter('all')} style={{ flex: 1, background: targetTypeFilter === 'all' ? '#1a4a4a' : '#111', color: '#00f0ff', border: '1px solid #00f0ff', padding: '6px', cursor: 'pointer', fontSize: '11px' }}>ВСЕ</button>
            <button onClick={() => setTargetTypeFilter('hub')} style={{ flex: 1, background: targetTypeFilter === 'hub' ? '#4a1a4a' : '#111', color: '#ff00ff', border: '1px solid #ff00ff', padding: '6px', cursor: 'pointer', fontSize: '11px' }}>HUB</button>
            <button onClick={() => setTargetTypeFilter('local')} style={{ flex: 1, background: targetTypeFilter === 'local' ? '#4a3a1a' : '#111', color: '#ffcc66', border: '1px solid #ffcc66', padding: '6px', cursor: 'pointer', fontSize: '11px' }}>LOCAL</button>
          </div>
          <label style={{ fontSize: '11px', color: '#bbb', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type='checkbox' checked={archiveOnly} onChange={e => setArchiveOnly(e.target.checked)} />
            Только цели с архивом
          </label>
          <div style={{ color: '#777', fontSize: '10px', marginTop: '6px' }}>Показано: {filteredTargets.length} из {targets.length}</div>
        </div>
        {filteredTargets.map(t => (
          <div key={t.id} style={{ border: '1px solid #222', padding: '10px', marginBottom: '8px', position: 'relative', backgroundColor: '#0a0a0c' }}>
            <div style={{ color: t.type === 'hub' ? '#ff00ff' : '#00f0ff', fontSize: '0.9rem', paddingRight: '20px' }}>{t.name}</div>
            <div style={{ fontSize: '10px', color: '#555', marginBottom: '8px' }}>{t.host}</div>

            {t.type === 'hub' ? (
                // ОБНОВЛЕННАЯ КНОПКА ОТКРЫТИЯ FTP ИЗ НИЖНЕГО СПИСКА
                <button onClick={() => fetchFtpRoot('video1')} style={{ width: '100%', backgroundColor: '#1a4a4a', color: '#00f0ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                  📁 АРХИВ (FTP)
                </button>
            ) : (
                <>
                  <button onClick={() => handleLocalArchive(t)} style={{ width: '100%', backgroundColor: '#4a1a4a', color: '#ff9900', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    ⏳ ЗАПРОС ПАМЯТИ
                  </button>
                  <button onClick={() => handleFetchNvrDeviceInfo(t)} style={{ width: '100%', marginTop: '6px', backgroundColor: '#1a1a4a', color: '#9fc2ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    ℹ ISAPI DEVICE INFO
                  </button>
                  <button onClick={() => handleSearchIsapiRecordings(t)} style={{ width: '100%', marginTop: '6px', backgroundColor: '#1f2d4a', color: '#9fd7ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    🔎 ISAPI SEARCH RECORDS
                  </button>
                  <button onClick={() => handleFetchOnvifDeviceInfo(t)} style={{ width: '100%', marginTop: '6px', backgroundColor: '#1a3a1a', color: '#a8ffb0', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    ℹ ONVIF DEVICE INFO
                  </button>
                  <button onClick={() => handleSearchOnvifRecordings(t)} style={{ width: '100%', marginTop: '6px', backgroundColor: '#1a3a1a', color: '#b9ffcf', border: '1px solid #2a5a36', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    🔎 ONVIF RECORDINGS
                  </button>
                  <button onClick={() => handleProbeArchiveExport(t)} style={{ width: '100%', marginTop: '6px', backgroundColor: '#3a2a1a', color: '#ffd27a', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                    📦 PROBE EXPORT ENDPOINTS
                  </button>
                </>
            )}

            <button onClick={() => handleDeleteTarget(t.id)} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', color: '#ff003c', cursor: 'pointer' }}>✖</button>
          </div>
        ))}

        <h3 style={{ color: '#00f0ff', marginTop: '30px', fontSize: '0.9rem' }}>LIVE-ЛОГИ ЯДРА</h3>
        <div style={{ border: '1px solid #222', background: '#050505', maxHeight: '180px', overflowY: 'auto', padding: '8px' }}>
          {runtimeLogs.length === 0 && (
            <div style={{ color: '#666', fontSize: '11px' }}>Логи пока пусты</div>
          )}
          {runtimeLogs.map((line, idx) => (
            <div key={`${idx}_${line}`} style={{ color: '#9fefff', fontSize: '10px', lineHeight: '1.4', marginBottom: '2px' }}>
              {line}
            </div>
          ))}
        </div>

        <h3 style={{ color: '#00f0ff', marginTop: '30px', fontSize: '0.9rem' }}>МЕНЕДЖЕР ЗАГРУЗОК</h3>
        <label style={{ fontSize: '11px', color: '#bbb', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
          <input type='checkbox' checked={resumeDownloads} onChange={e => setResumeDownloads(e.target.checked)} />
          Включить докачку (resume)
        </label>
        <button
          onClick={clearFinishedDownloads}
          style={{ width: '100%', marginBottom: '6px', background: '#111', color: '#aaa', border: '1px solid #333', padding: '6px', cursor: 'pointer', fontSize: '11px' }}
        >
          ОЧИСТИТЬ ЗАВЕРШЕННЫЕ/ОШИБКИ
        </button>
        <div style={{ border: '1px solid #222', background: '#050505', maxHeight: '220px', overflowY: 'auto', padding: '8px' }}>
          {downloadTasks.length === 0 && (
            <div style={{ color: '#666', fontSize: '11px' }}>Загрузок пока нет</div>
          )}
          {downloadTasks.map((task) => (
            <div key={task.id} style={{ border: '1px solid #111', padding: '6px', marginBottom: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                <span style={{ color: '#ddd' }}>{task.filename}</span>
                <span style={{ color: task.status === 'done' ? '#00ff9c' : task.status === 'error' ? '#ff5555' : task.status === 'cancelled' ? '#caa0ff' : '#ffcc66' }}>
                  {task.status === 'running' ? 'В ПРОЦЕССЕ' : task.status === 'done' ? 'ГОТОВО' : task.status === 'cancelled' ? 'ОТМЕНЕНО' : 'ОШИБКА'}
                </span>
              </div>
              <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>
                {task.serverAlias} • {formatBytes(task.bytesWritten)}
                {task.speedBytesSec > 0 ? ` • ${formatBytes(task.speedBytesSec)}/s` : ''}
                {task.resumed ? ' • RESUME' : ''}
                {task.skipped ? ' • SKIPPED' : ''}
              </div>
              <div style={{ height: '4px', background: '#111', marginTop: '6px' }}>
                <div
                  style={{
                    width: `${task.percent ?? (task.status === 'running' ? 10 : 0)}%`,
                    height: '100%',
                    background: task.status === 'error' ? '#ff5555' : '#00f0ff',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>

              {task.status === 'running' && (
                <button
                  onClick={() => handleCancelDownloadTask(task)}
                  style={{ marginTop: '6px', marginRight: '6px', background: '#2d1a4a', color: '#d8b0ff', border: '1px solid #b36bff', padding: '4px 8px', cursor: 'pointer', fontSize: '10px' }}
                >
                  ОТМЕНИТЬ
                </button>
              )}


              {task.status === 'error' && (
                <button
                  onClick={() => handleRetryDownloadTask(task)}
                  style={{ marginTop: '6px', background: '#4a1a1a', color: '#ffaaaa', border: '1px solid #ff5555', padding: '4px 8px', cursor: 'pointer', fontSize: '10px' }}
                >
                  ПОВТОРИТЬ ЗАГРУЗКУ
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
