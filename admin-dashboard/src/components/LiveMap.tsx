import { useEffect, useRef, useState } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { Expand, MapPinned } from 'lucide-react';
import type { Officer, Settings, Location } from '../types';
import { labels, time, trackingState } from '../lib/format';
import { ErrorNotice } from './ui';

let configured = false;
export function LiveMap({ officers, settings, now, selected, select, route }: { officers: Officer[]; settings: Settings; now: number; selected: string | null; select(id: string): void; route?: Location[] }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<google.maps.Map | null>(null), cluster = useRef<MarkerClusterer | null>(null), info = useRef<google.maps.InfoWindow | null>(null);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>()), latest = useRef({ officers, settings, now, select }); latest.current = { officers, settings, now, select };
  const [ready, setReady] = useState(false), [error, setError] = useState(''); const firstFit = useRef(false);
  const missing = !__GOOGLE_MAPS_API_KEY__ || !__GOOGLE_MAPS_MAP_ID__;
  function fit() { if (!map.current) return; const bounds = new google.maps.LatLngBounds(); for (const marker of markers.current.values()) if (marker.position) bounds.extend(marker.position as google.maps.LatLngLiteral); for (const point of route ?? []) bounds.extend({ lat: point.latitude, lng: point.longitude }); if (!bounds.isEmpty()) map.current.fitBounds(bounds, 65); }
  useEffect(() => {
    if (!ready || !map.current || !route?.length) return;
    const line = new google.maps.Polyline({ map: map.current, path: route.map(point => ({ lat: point.latitude, lng: point.longitude })), strokeColor: '#087f68', strokeOpacity: 0.8, strokeWeight: 4 }); fit(); return () => line.setMap(null);
  }, [route, ready]);
  function show(id: string, pan: boolean) {
    const row = latest.current.officers.find(item => item.fmo.id === id), marker = markers.current.get(id); if (!row?.lastLocation || !marker || !map.current) { info.current?.close(); return; }
    const node = document.createElement('div'); node.className = 'map-info';
    const fields = [row.fmo.name, row.fmo.employeeCode + (row.fmo.isDemo ? ' · DEMO' : ''), labels[trackingState(row, latest.current.settings, latest.current.now)] ?? '',
      'Duty start: ' + time(row.session?.startTime, latest.current.settings.timezone), 'Check-in: ' + time(row.attendance?.checkInTime, latest.current.settings.timezone),
      'Last observation: ' + time(row.lastLocation.recordedAt, latest.current.settings.timezone, true), 'GPS accuracy: ' + Math.round(row.lastLocation.accuracy) + 'm · ' + row.lastLocation.quality,
      row.lastLocation.latitude.toFixed(6) + ', ' + row.lastLocation.longitude.toFixed(6)];
    fields.forEach((value, index) => { const line = document.createElement(index === 0 ? 'strong' : 'div'); line.textContent = value; node.append(line); }); // No officer-supplied HTML.
    info.current?.setContent(node); info.current?.open({ map: map.current, anchor: marker, shouldFocus: false });
    if (pan && marker.position) { map.current.panTo(marker.position as google.maps.LatLngLiteral); map.current.setZoom(16); }
  }
  useEffect(() => {
    if (missing) return; let alive = true;
    if (!configured) { setOptions({ key: __GOOGLE_MAPS_API_KEY__, v: 'quarterly' }); configured = true; }
    const authWindow = window as typeof window & { gm_authFailure?: () => void }; const prior = authWindow.gm_authFailure;
    authWindow.gm_authFailure = () => { if (alive) setError('Google Maps authentication failed. Check the configured browser key, billing and domain restrictions.'); };
    const timeout = setTimeout(() => { if (alive && !map.current) setError('Google Maps is taking too long to load. Check network access and key configuration.'); }, 20000);
    void Promise.all([importLibrary('maps'), importLibrary('marker')]).then(([maps]) => {
      if (!alive || !container.current) return;
      // Neutral world view only; no invented officer coordinates or fallback markers.
      map.current = new maps.Map(container.current, { center: { lat: 0, lng: 0 }, zoom: 2, mapId: __GOOGLE_MAPS_MAP_ID__, streetViewControl: false, mapTypeControl: false, fullscreenControl: false, gestureHandling: 'cooperative' });
      info.current = new maps.InfoWindow(); cluster.current = new MarkerClusterer({ map: map.current }); setReady(true); clearTimeout(timeout);
    }).catch(() => { if (alive) setError('Google Maps could not load. Officer details remain available in the list.'); });
    return () => { alive = false; clearTimeout(timeout); authWindow.gm_authFailure = prior; info.current?.close(); cluster.current?.clearMarkers(); cluster.current?.setMap(null); for (const marker of markers.current.values()) marker.map = null; markers.current.clear(); map.current = null; firstFit.current = false; };
  }, [missing]);
  useEffect(() => {
    if (!ready || !map.current || !cluster.current) return;
    const ids = new Set<string>(); let moved = false;
    for (const row of officers) {
      if (row.session?.status !== 'ACTIVE' || !row.lastLocation) continue;
      const location = row.lastLocation; ids.add(row.fmo.id); let marker = markers.current.get(row.fmo.id);
      const state = trackingState(row, settings, now); const color = location.mocked || location.quality === 'POOR' ? '#b45d24' : state === 'TRACKING' ? '#087f68' : '#7c8584';
      if (!marker) {
        const node = document.createElement('div'); node.className = 'officer-pin'; node.textContent = row.fmo.employeeCode.split('-').at(-1) ?? 'FMO';
        marker = new google.maps.marker.AdvancedMarkerElement({ position: { lat: location.latitude, lng: location.longitude }, title: row.fmo.name, content: node });
        marker.addListener('click', () => { latest.current.select(row.fmo.id); show(row.fmo.id, false); });
        markers.current.set(row.fmo.id, marker); cluster.current.addMarker(marker, true); moved = true;
      } else {
        const previous = marker.position as google.maps.LatLngLiteral | null;
        if (!previous || previous.lat !== location.latitude || previous.lng !== location.longitude) { marker.position = { lat: location.latitude, lng: location.longitude }; moved = true; }
      }
      (marker.content as HTMLElement).style.backgroundColor = color;
    }
    for (const [id, marker] of markers.current) if (!ids.has(id)) { cluster.current.removeMarker(marker, true); marker.map = null; markers.current.delete(id); moved = true; }
    if (moved) { // Reset clustering's spatial index after coordinate changes.
      cluster.current.setMap(null);
      cluster.current = new MarkerClusterer({ map: map.current, markers: [...markers.current.values()] });
    }
    if (!firstFit.current && markers.current.size) { fit(); firstFit.current = true; }
    if (selected) show(selected, false);
  }, [officers, settings, now, ready, selected]);
  useEffect(() => { if (ready && selected) show(selected, true); }, [selected, ready]);
  return <div className="map-shell"><div ref={container} className="map-canvas" aria-label="Google map of active FMO locations" />
    {missing && <div className="map-placeholder"><MapPinned size={38} /><h3>Connect your operations map</h3><p>Configure the Google Maps browser key and map ID to display actual duty locations. Live officer details are available alongside.</p><span>No simulated locations</span></div>}
    {!missing && !ready && !error && <div className="map-placeholder"><MapPinned size={32} /><p>Loading Google Maps…</p></div>}
    {error && <div className="map-error"><ErrorNotice message={error} /></div>}
    {ready && <button className="button map-fit" onClick={fit}><Expand size={16} />{route ? 'Fit full route' : 'Fit all FMOs'}</button>}
    <div className="map-legend"><span><i className="dot green" />Recent</span><span><i className="dot grey" />Stale / offline</span><span><i className="dot amber" />GPS needs review</span></div>
  </div>;
}
