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
  // --- ЛОКАЛЬНЫЕ ЦЕЛИ И КАРТА ---
  const [targets, setTargets] = useState([]);
  const [activeStream, setActiveStream] = useState(null);
  const [streamType, setStreamType] = useState('hls'); // 'hls' или 'mjpeg'
  const [activeTargetId, setActiveTargetId] = useState(null);
  const [activeCameraName, setActiveCameraName] = useState('');

  const [loading, setLoading] = useState(false);
  const [radarStatus, setRadarStatus] = useState('');

  const [addressQuery, setAddressQuery] = useState('');
  const [mapCenter, setMapCenter] = useState([53.9, 27.56]);
  const [form, setForm] = useState({ name: '', host: '', login: 'admin', password: '', lat: 53.9, lng: 27.56, channelCount: 4 });

  // --- ГЛОБАЛЬНЫЙ ХАБ ---
  const [hubSearch, setHubSearch] = useState('');
  const [hubResults, setHubResults] = useState([]);
  const [ftpFiles, setFtpFiles] = useState([]);
  const [activeFtpIp, setActiveFtpIp] = useState(null);

  // Конфиг Хаба
  const hubConfig = {
    cookie: "login=mvd; admin=d32e003ac0909010c412e0930b621f8f",
    ftpHosts: ["93.125.48.66", "93.125.48.100"],
    ftpUser: "mvd",
    ftpPass: "gpfZrw%9RVqp"
  };

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollIntervalRef = useRef(null);

  useEffect(() => { loadTargets(); }, []);

  // Инициализация Video.js
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

  // --- ИНТЕЛЛЕКТУАЛЬНЫЙ СТРИМИНГ (HLS + MJPEG) ---
  const handleStartStream = async (terminal, channel) => {
    try {
      if (activeTargetId) {
        await invoke('stop_stream', { targetId: activeTargetId });
        setActiveStream(null);
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      }

      // 1. ПЕРЕХВАТ КАМЕРЫ ИЗ ХАБА (Без FFmpeg)
      if (terminal.type === 'hub') {
        setStreamType('mjpeg');
        const mjpegUrl = `https://videodvor.by/stream/rtsp2mjpeg.php?get=1&user=user3&id=${terminal.hub_id}&random=${Date.now()}`;
        setActiveStream(mjpegUrl);
        setActiveCameraName(`${terminal.name}`);
        setActiveTargetId(terminal.id);
        return;
      }

      // 2. ПЕРЕХВАТ RTSP КАМЕРЫ (Через FFmpeg)
      setLoading(true);
      setRadarStatus('РАЗВЕДКА МАРШРУТА...');

      let cleanHost = terminal.host.replace(/^(http:\/\/|https:\/\/|rtsp:\/\/)/i, '').split('/')[0];
      const activePath = await invoke('probe_rtsp_path', { host: cleanHost, login: terminal.login, pass: terminal.password });
      const safePath = activePath.replace(/channel=1|ch1|Channels\/1/g, (match) => match.replace('1', channel.index));
      const rtspUrl = `rtsp://${terminal.login}:${terminal.password}@${cleanHost}/${safePath.replace(/^\//, '')}`;

      const streamSessionId = `${terminal.id}_${channel.id}`;
      setRadarStatus('ЗАПУСК ЯДРА FFMPEG...');
      await invoke('start_stream', { targetId: streamSessionId, rtspUrl });

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
            setActiveCameraName(`${terminal.name} :: Камера ${channel.index}`);
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
      setActiveTargetId(null);
    }
    setActiveStream(null);
    setActiveCameraName('');
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  };

  // --- ФУНКЦИИ ГЛОБАЛЬНОГО ХАБА ---
  const handleHubSearch = async () => {
    try {
        setLoading(true);
        setRadarStatus('СКАНИРОВАНИЕ БАЗЫ ХАБА...');
        const res = await invoke('search_global_hub', { query: hubSearch, cookie: hubConfig.cookie });
        setHubResults(res);
        setLoading(false);
    } catch (err) {
        alert("ОШИБКА РАЗВЕДКИ: " + err);
        setLoading(false);
    }
  };

  const handleHubStream = (camera) => {
      setStreamType('mjpeg');
      const mjpegUrl = `https://videodvor.by/stream/rtsp2mjpeg.php?get=1&user=user3&id=${camera.id}&random=${Date.now()}`;
      setActiveStream(mjpegUrl);
      setActiveCameraName(`GLOBAL HUB :: ${camera.ip}`);
  };

  const handleScanFtp = async (ip) => {
    setLoading(true);
    let foundFiles = [];
    let success = false;

    for (const currentHost of hubConfig.ftpHosts) {
      try {
        setRadarStatus(`ПРОВЕРКА FTP: ${currentHost}...`);
        const files = await invoke('scan_ftp_archive', {
            ip: ip,
            ftpHost: currentHost,
            ftpUser: hubConfig.ftpUser,
            ftpPass: hubConfig.ftpPass
        });
        foundFiles = files;
        success = true;
        break;
      } catch (err) {
        console.log(`[РАДАР] На сервере ${currentHost} пусто. Ищем дальше...`);
      }
    }

    if (success) {
      setFtpFiles(foundFiles);
      setActiveFtpIp(ip);
    } else {
      alert(`ОШИБКА: Архив для камеры ${ip} не найден ни на одном из серверов.`);
    }
    setLoading(false);
  };

  const handleDownloadFtp = async (filename) => {
    setLoading(true);
    let downloaded = false;

    for (const host of hubConfig.ftpHosts) {
      try {
        setRadarStatus(`СКАЧИВАНИЕ ${filename} С ${host}...`);
        await invoke('download_ftp_file', { ip: activeFtpIp, filename: filename, ftpHost: host, ftpUser: hubConfig.ftpUser, ftpPass: hubConfig.ftpPass });
        alert(`УСПЕШНО: Файл ${filename} сохранен в D:\\Nemesis_Vault\\archives\\${activeFtpIp}`);
        downloaded = true;
        break;
      } catch (err) {
        console.log(`[FTP] Ошибка скачивания с ${host}, пробуем следующий...`);
      }
    }
    if (!downloaded) alert(`ОШИБКА: Не удалось скачать файл ${filename}.`);
    setLoading(false);
  };

  // --- ЭКСПОРТ КАМЕРЫ ИЗ ХАБА НА КАРТУ ---
  const handleSaveHubToLocal = async (cam) => {
    const lat = mapCenter[0];
    const lng = mapCenter[1];
    const autoId = `hub_${cam.id}_${Date.now()}`;
    const payload = JSON.stringify({
      id: autoId,
      name: `ХАБ: ${cam.ip}`,
      host: cam.ip,
      hub_id: cam.id,
      type: 'hub',
      lat: lat,
      lng: lng,
      channels: [{ id: 'ch1', index: 1, name: 'Прямой эфир (MJPEG)' }]
    });

    await invoke('save_target', { targetId: autoId, payload });
    loadTargets();
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0a0a0c', color: '#fff', fontFamily: 'monospace' }}>

      {loading && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#00f0ff' }}>
          <div style={{ fontSize: '24px', letterSpacing: '5px', marginBottom: '20px' }}>[ ОБРАБОТКА ДАННЫХ ]</div>
          <div style={{ fontSize: '14px', color: '#ff003c' }}>{radarStatus}</div>
        </div>
      )}

      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer center={mapCenter} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
          <MapController center={mapCenter} />
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

          {targets.map(t => (
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

            {streamType === 'hls' ? (
              <div data-vjs-player>
                <video ref={videoRef} className="video-js vjs-big-play-centered" />
              </div>
            ) : (
              <img
                src={activeStream}
                alt="NO SIGNAL"
                style={{ width: '100%', minHeight: '300px', objectFit: 'contain', display: 'block' }}
              />
            )}

          </div>
        )}
      </div>

      <div style={{ width: '400px', backgroundColor: '#111115', borderLeft: '2px solid #ff003c', padding: '20px', overflowY: 'auto' }}>
        <h2 style={{ color: '#ff003c', fontSize: '1.2rem', marginBottom: '20px' }}>HYPERION NODE</h2>

        {/* --- ПАНЕЛЬ ГЛОБАЛЬНОГО ХАБА (VIDEODVOR) --- */}
        <div style={{ border: '1px solid #ff003c', padding: '10px', backgroundColor: '#1a0505', marginBottom: '20px' }}>
          <h3 style={{ color: '#ff003c', marginTop: '0', fontSize: '0.9rem' }}>GLOBAL HUB: MVD LINK</h3>
          <div style={{ display: 'flex', marginBottom: '10px' }}>
              <input
                  style={{ flex: 1, backgroundColor: '#000', border: '1px solid #ff003c', color: '#ff003c', padding: '8px' }}
                  placeholder="Поиск адреса..."
                  value={hubSearch}
                  onChange={e => setHubSearch(e.target.value)}
              />
              <button style={{ backgroundColor: '#ff003c', color: '#fff', border: 'none', padding: '8px', cursor: 'pointer', fontWeight: 'bold' }} onClick={handleHubSearch}>СКАН</button>
          </div>

          {hubResults.map(cam => (
              <div key={cam.id} style={{ border: '1px solid #444', padding: '10px', marginBottom: '8px', backgroundColor: '#050505' }}>
                  <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '12px' }}>IP: {cam.ip}</div>
                  <div style={{ fontSize: '10px', color: '#888', marginBottom: '8px' }}>ID: {cam.id}</div>

                  <div style={{ display: 'flex', gap: '5px' }}>
                      <button onClick={() => handleHubStream(cam)} style={{ flex: 1, backgroundColor: '#00f0ff', color: '#000', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>LIVE</button>
                      <button onClick={() => handleScanFtp(cam.ip)} style={{ flex: 1, backgroundColor: '#1a4a4a', color: '#00f0ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px' }}>FTP</button>
                      <button onClick={() => handleSaveHubToLocal(cam)} style={{ flex: 1, backgroundColor: '#4a1a4a', color: '#ff00ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>📌 В Базу</button>
                  </div>

                  {activeFtpIp === cam.ip && ftpFiles.length > 0 && (
                      <div style={{ marginTop: '10px', maxHeight: '150px', overflowY: 'auto', borderTop: '1px solid #333', paddingTop: '5px' }}>
                          {ftpFiles.map(file => (
                              <div key={file} style={{ fontSize: '11px', padding: '4px 0', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{color: '#aaa'}}>{file}</span>
                                  <button onClick={() => handleDownloadFtp(file)} style={{ background: 'none', border: '1px solid #ff003c', color: '#ff003c', cursor: 'pointer', padding: '2px 5px', fontSize: '10px' }}>СКАЧАТЬ</button>
                              </div>
                          ))}
                      </div>
                  )}
              </div>
          ))}
        </div>

        <hr style={{ borderColor: '#222' }} />

        {/* --- ПАНЕЛЬ ЛОКАЛЬНЫХ ТЕРМИНАЛОВ --- */}
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
        {targets.map(t => (
          <div key={t.id} style={{ border: '1px solid #222', padding: '10px', marginBottom: '8px', position: 'relative', backgroundColor: '#0a0a0c' }}>
            <div style={{ color: t.type === 'hub' ? '#ff00ff' : '#00f0ff', fontSize: '0.9rem' }}>{t.name}</div>
            <div style={{ fontSize: '10px', color: '#555' }}>{t.host}</div>
            <button onClick={() => handleDeleteTarget(t.id)} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', color: '#ff003c', cursor: 'pointer' }}>✖</button>
          </div>
        ))}
      </div>
    </div>
  );
}