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
  const [activeTargetId, setActiveTargetId] = useState(null);
  const [activeCameraName, setActiveCameraName] = useState('');
  const [loading, setLoading] = useState(false);

  const [addressQuery, setAddressQuery] = useState('');
  const [mapCenter, setMapCenter] = useState([53.9, 27.56]);

  const [form, setForm] = useState({
    name: '', host: '', login: 'admin', password: '', lat: 53.9, lng: 27.56, channelCount: 4
  });

  const videoRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => { loadTargets(); }, []);

  // --- ИНИЦИАЛИЗАЦИЯ VIDEO.JS (БРОНЕБОЙНЫЙ ПЛЕЕР) ---
  useEffect(() => {
    if (activeStream && videoRef.current) {
      // Полная ликвидация старого плеера перед запуском нового
      if (playerRef.current) {
        playerRef.current.dispose();
      }

      const player = videojs(videoRef.current, {
        autoplay: true,
        controls: true,
        responsive: true,
        fluid: true,
        liveui: true,
        preload: 'auto',
        sources: [{
          src: activeStream,
          type: 'application/x-mpegURL'
        }],
        html5: {
          vhs: {
            overrideNative: true,
            fastQualityChange: true,
            enableLowInitialPlaylist: true,
            smoothQualityChange: true
          }
        }
      });

      player.on('error', () => {
        const error = player.error();
        console.warn("Player error detected:", error);
      });

      playerRef.current = player;
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [activeStream]);

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

  const handleDeleteTarget = async (id) => {
    if (window.confirm(`Удалить объект из базы?`)) {
      try {
        await invoke('delete_target', { targetId: id });
        loadTargets();
      } catch (err) { alert(err); }
    }
  };

  const handleGeocode = async () => {
    try {
      const [lat, lng] = await invoke('geocode_address', { address: addressQuery });
      setForm({ ...form, lat, lng });
      setMapCenter([lat, lng]);
    } catch (err) { alert("Адрес не найден"); }
  };

  const handleSmartSave = async () => {
    if (!form.host) return alert("Требуется IP");
    try {
      const autoId = `nvr_${Date.now()}`;
      const channels = [];
      for(let i=1; i<=form.channelCount; i++) {
        channels.push({ id: `ch${i}`, index: i, name: `Камера ${i}` });
      }
      const payload = JSON.stringify({
        id: autoId, name: form.name || form.host, host: form.host,
        login: form.login, password: form.password, lat: form.lat, lng: form.lng, channels
      });
      await invoke('save_target', { targetId: autoId, payload });
      loadTargets();
      setForm({ ...form, name: '', host: '', password: '' });
    } catch (err) { alert(err); }
  };

  const handleStartStream = async (terminal, channel) => {
    try {
      setLoading(true);
      setActiveCameraName(`ПОДГОТОВКА СЕССИИ...`);

      // Принудительная остановка старого процесса, если он есть
      if (activeTargetId) {
        await invoke('stop_stream', { targetId: activeTargetId });
        setActiveStream(null);
      }

      let cleanHost = terminal.host.replace(/^(http:\/\/|https:\/\/|rtsp:\/\/)/i, '').split('/')[0];
      const activePath = await invoke('probe_rtsp_path', { host: cleanHost, login: terminal.login, pass: terminal.password });

      const safePath = activePath.replace(/channel=1|ch1|Channels\/1/g, (match) => match.replace('1', channel.index));
      const rtspUrl = `rtsp://${terminal.login}:${terminal.password}@${cleanHost}/${safePath.replace(/^\//, '')}`;

      const streamSessionId = `${terminal.id}_${channel.id}`;
      await invoke('start_stream', { targetId: streamSessionId, rtspUrl });

      //
      setTimeout(() => {
        // Добавляем timestamp для обхода кэша браузера
        const antiCacheUrl = `http://127.0.0.1:49152/${streamSessionId}/stream.m3u8?t=${Date.now()}`;
        setActiveStream(antiCacheUrl);
        setActiveTargetId(streamSessionId);
        setActiveCameraName(`${terminal.name} :: Камера ${channel.index}`);
        setLoading(false);
      }, 5000);

    } catch (err) {
      alert("СБОЙ: " + err);
      setLoading(false);
    }
  };

  const handleStopStream = async () => {
    if (activeTargetId) {
      await invoke('stop_stream', { targetId: activeTargetId });
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
      setActiveStream(null);
      setActiveTargetId(null);
      setActiveCameraName('');
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0a0a0c', color: '#fff', fontFamily: 'monospace' }}>
      {loading && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#00f0ff', fontSize: '18px' }}>
          [ СИСТЕМА ПЕРЕХВАТА: ТРАНСКОДИРОВАНИЕ HEVC... ]
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
                        🎥 ПЕРЕХВАТ: {ch.name}
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
            {/* Обертка для Video.js */}
            <div data-vjs-player>
              <video ref={videoRef} className="video-js vjs-big-play-centered vjs-theme-city" />
            </div>
          </div>
        )}
      </div>

      <div style={{ width: '380px', backgroundColor: '#111115', borderLeft: '2px solid #ff003c', padding: '20px', overflowY: 'auto' }}>
        <h2 style={{ color: '#ff003c', fontSize: '1.2rem', marginBottom: '20px' }}>HYPERION NODE</h2>
        <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #00f0ff', color: '#00f0ff', padding: '10px', marginBottom: '8px' }} placeholder="Адрес поиска" value={addressQuery} onChange={e => setAddressQuery(e.target.value)} />
        <button style={{ width: '100%', padding: '10px', backgroundColor: '#1a4a4a', color: '#00f0ff', border: '1px solid #00f0ff', cursor: 'pointer', marginBottom: '20px' }} onClick={handleGeocode}>GEO-SCAN</button>
        <hr style={{ borderColor: '#222' }} />
        <div style={{ marginTop: '20px' }}>
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px' }} placeholder="Имя узла" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px' }} placeholder="IP (93.125.3.58:554)" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px' }} placeholder="Логин" value={form.login} onChange={e => setForm({ ...form, login: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '8px' }} type="password" placeholder="Пароль" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <input style={{ width: '100%', backgroundColor: '#000', border: '1px solid #333', color: '#00f0ff', padding: '10px', marginBottom: '15px' }} type="number" placeholder="Каналы" value={form.channelCount} onChange={e => setForm({ ...form, channelCount: e.target.value })} />
          <button style={{ width: '100%', padding: '12px', backgroundColor: '#ff003c', color: '#fff', fontWeight: 'bold', cursor: 'pointer', border: 'none' }} onClick={handleSmartSave}>VAULT STORAGE</button>
        </div>
        <h3 style={{ color: '#ff003c', marginTop: '40px', fontSize: '0.9rem' }}>BATTLE LOG: TARGETS</h3>
        {targets.map(t => (
          <div key={t.id} style={{ border: '1px solid #222', padding: '10px', marginBottom: '8px', position: 'relative', backgroundColor: '#0a0a0c' }}>
            <div style={{ color: '#00f0ff', fontSize: '0.9rem' }}>{t.name}</div>
            <div style={{ fontSize: '10px', color: '#555' }}>{t.host}</div>
            <button onClick={() => handleDeleteTarget(t.id)} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', color: '#ff003c', cursor: 'pointer' }}>✖</button>
          </div>
        ))}
      </div>
    </div>
  );
}