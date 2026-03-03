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

  const hubConfig = {
    cookie: "login=mvd; admin=d32e003ac0909010c412e0930b621f8f; PHPSESSID=d8qtnapeqlgrism37hkarq9mk5",
  };

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollIntervalRef = useRef(null);

  useEffect(() => { loadTargets(); }, []);

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
    setLoading(true);
    setRadarStatus(`СКАЧИВАНИЕ ФАЙЛА: ${filename}...`);
    try {
        await invoke('download_ftp_file', {
            serverAlias,
            folderPath,
            filename
        });
        alert(`Файл ${filename} успешно скачан в D:\\Nemesis_Vault\\recon_db\\archives\\${serverAlias}\\`);
    } catch (err) {
        alert(`Ошибка скачивания: ${err}`);
    } finally {
        setLoading(false);
    }
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

  const handleLocalArchive = (terminal) => {
      alert(`СИСТЕМНОЕ СООБЩЕНИЕ\n\nМодуль извлечения памяти для локальных узлов (${terminal.host}) находится в разработке.\n\nПланируется внедрение протоколов ISAPI/ONVIF и RTSP Time-Shift для прямого скачивания блоков памяти регистратора.`);
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

                    {t.type === 'hub' ? (
                        <button onClick={() => fetchFtpRoot('video1')} style={{ display: 'block', width: '100%', marginTop: '8px', padding: '6px', cursor: 'pointer', backgroundColor: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', fontSize: '11px', fontWeight: 'bold' }}>
                          📁 АРХИВ ХАБА (FTP)
                        </button>
                    ) : (
                        <button onClick={() => handleLocalArchive(t)} style={{ display: 'block', width: '100%', marginTop: '8px', padding: '6px', cursor: 'pointer', backgroundColor: '#4a1a1a', color: '#ff9900', border: '1px solid #ff9900', fontSize: '11px', fontWeight: 'bold' }}>
                          ⏳ АРХИВ УЗЛА (В РАЗРАБОТКЕ)
                        </button>
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
            <div style={{ color: t.type === 'hub' ? '#ff00ff' : '#00f0ff', fontSize: '0.9rem', paddingRight: '20px' }}>{t.name}</div>
            <div style={{ fontSize: '10px', color: '#555', marginBottom: '8px' }}>{t.host}</div>

            {t.type === 'hub' ? (
                // ОБНОВЛЕННАЯ КНОПКА ОТКРЫТИЯ FTP ИЗ НИЖНЕГО СПИСКА
                <button onClick={() => fetchFtpRoot('video1')} style={{ width: '100%', backgroundColor: '#1a4a4a', color: '#00f0ff', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                  📁 АРХИВ (FTP)
                </button>
            ) : (
                <button onClick={() => handleLocalArchive(t)} style={{ width: '100%', backgroundColor: '#4a1a4a', color: '#ff9900', border: 'none', padding: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                  ⏳ ЗАПРОС ПАМЯТИ
                </button>
            )}

            <button onClick={() => handleDeleteTarget(t.id)} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', color: '#ff003c', cursor: 'pointer' }}>✖</button>
          </div>
        ))}
      </div>
    </div>
  );
}