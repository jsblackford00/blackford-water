// main.js - Blackford Water visualization (Colorado River Basin)
// Requires: Leaflet, Leaflet.markercluster, Chart.js (loaded in index.html)

const basinStates = ['CO','NM','WY','UT','AZ','NV','CA'];

// Map initialization
const map = L.map('map').setView([37.0, -111.5], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Marker cluster group for performance
let dischargeLayer = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });
map.addLayer(dischargeLayer);

// UI elements
const summaryEl = document.getElementById('summary');
const stateSelect = document.getElementById('state-select');
const toggleDischarge = document.getElementById('toggle-discharge');
const refreshBtn = document.getElementById('refresh-btn');

// Simple in-memory cache for this session
const _usgsCache = new Map();

// Helper: fetch instantaneous values for a single state (parameter 00060 = discharge cfs)
async function fetchUSGSInstant(stateCd) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=${stateCd}&parameterCd=00060&siteStatus=active`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS fetch failed for ${stateCd}`);
  return res.json();
}

// Parse USGS JSON into site objects
function parseUSGS(data) {
  const sites = [];
  const timeSeries = data?.value?.timeSeries || [];
  for (const ts of timeSeries) {
    const sourceInfo = ts.sourceInfo || {};
    const siteCode = sourceInfo.siteCode?.[0]?.value;
    const name = sourceInfo.siteName || 'Unknown';
    const geo = sourceInfo.geoLocation?.geogLocation;
    const lat = geo?.latitude;
    const lon = geo?.longitude;
    const values = ts.values?.[0]?.value;
    const last = values && values.length ? values[values.length - 1] : null;
    const value = last ? last.value : null;
    const time = last ? last.dateTime : null;
    const unit = ts.variable?.unit?.unitCode;
    const siteUrl = siteCode ? `https://waterdata.usgs.gov/nwis/uv?site_no=${siteCode}` : '#';
    if (siteCode && lat && lon) {
      sites.push({ id: siteCode, name, lat, lon, value, unit, time, siteUrl });
    }
  }
  return sites;
}

// Fetch multiple states in parallel with caching
async function fetchUSGSForStates(stateCodes) {
  const promises = stateCodes.map(async code => {
    if (_usgsCache.has(code)) return _usgsCache.get(code);
    try {
      const raw = await fetchUSGSInstant(code);
      const parsed = parseUSGS(raw);
      _usgsCache.set(code, parsed);
      return parsed;
    } catch (e) {
      console.error('USGS fetch error for', code, e);
      return [];
    }
  });
  const results = await Promise.all(promises);
  return results.flat();
}

// Deduplicate by site id (keep first seen)
function dedupeSitesById(sites) {
  const seen = new Map();
  for (const s of sites) {
    if (!seen.has(s.id)) seen.set(s.id, s);
  }
  return Array.from(seen.values());
}

// Color ramp for discharge values
function getColorByValue(v) {
  if (isNaN(v)) return '#999';
  if (v < 10) return '#2b83ba';
  if (v < 100) return '#abdda4';
  if (v < 500) return '#fdae61';
  return '#d7191c';
}

// Create canvas HTML for sparkline
function createSparklineCanvas(id) {
  return `<div style="width:100%;height:80px;margin-top:6px"><canvas id="${id}" width="300" height="80"></canvas></div>`;
}

// Escape HTML for safety
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Fetch last N days of daily values (dv)
async function fetchUSGSDaily(siteId, days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const startStr = start.toISOString().slice(0,10);
  const endStr = end.toISOString().slice(0,10);
  const url = `https://waterservices.usgs.gov/nwis/dv/?format=json&sites=${siteId}&startDT=${startStr}&endDT=${endStr}&parameterCd=00060`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const ts = data?.value?.timeSeries?.[0];
    if (!ts || !ts.values || !ts.values[0]) return null;
    return ts.values[0].value.map(v => ({ date: v.dateTime.slice(0,10), value: v.value === '' ? null : parseFloat(v.value) }));
  } catch (e) {
    console.warn('Daily fetch failed for', siteId, e);
    return null;
  }
}

// Render discharge markers with popups and sparkline charts
function renderDischarge(sites) {
  dischargeLayer.clearLayers();

  for (const s of sites) {
    const color = s.value !== null ? getColorByValue(parseFloat(s.value)) : '#999';
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: 6,
      fillColor: color,
      color: '#222',
      weight: 0.6,
      fillOpacity: 0.9
    });

    const canvasId = `chart-${s.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const popupHtml = `
      <div style="min-width:260px">
        <strong>${escapeHtml(s.name)}</strong><br/>
        <b>Site</b>: ${escapeHtml(s.id)}<br/>
        <b>Discharge</b>: ${s.value ?? 'n/a'} ${s.unit ?? ''}<br/>
        <b>Time</b>: ${s.time ?? 'n/a'}<br/>
        ${createSparklineCanvas(canvasId)}
        <div style="margin-top:6px"><a href="${s.siteUrl}" target="_blank" rel="noopener">USGS site page</a></div>
      </div>
    `;

    marker.bindPopup(popupHtml);

    marker.on('popupopen', async () => {
      try {
        // small delay to ensure DOM canvas exists
        await new Promise(r => setTimeout(r, 50));
        const data = await fetchUSGSDaily(s.id, 30);
        if (!data) return;
        const labels = data.map(d => d.date);
        const vals = data.map(d => d.value);
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        if (ctx._chartInstance) try { ctx._chartInstance.destroy(); } catch(e){}
        ctx._chartInstance = new Chart(ctx.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'cfs',
              data: vals,
              borderColor: '#0b6fbf',
              backgroundColor: 'rgba(11,111,191,0.08)',
              pointRadius: 0,
              spanGaps: true,
              tension: 0.2
            }]
          },
          options: {
            responsive: false,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { display: true, ticks: { maxTicksLimit: 4 } } },
            elements: { line: { borderWidth: 1.5 } }
          }
        });
      } catch (e) {
        console.error('Error rendering sparkline for', s.id, e);
      }
    });

    marker.on('click', () => {
      summaryEl.innerHTML = `<p><strong>${escapeHtml(s.name)}</strong><br/>Latest discharge ${s.value ?? 'n/a'} ${s.unit ?? ''}<br/>Time ${s.time ?? 'n/a'}</p><p><a href="${s.siteUrl}" target="_blank" rel="noopener">Open USGS site page</a></p>`;
    });

    dischargeLayer.addLayer(marker);
  }
}

// Legend control
const legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
  const div = L.DomUtil.create('div', 'info legend');
  const grades = [0,10,100,500];
  let html = '<strong>Discharge (cfs)</strong><br/>';
  for (let i = 0; i < grades.length; i++) {
    const from = grades[i];
    const to = grades[i+1];
    const color = getColorByValue(from + 1);
    html += `<i style="background:${color};width:12px;height:12px;display:inline-block;margin-right:6px;border:1px solid #222"></i> ${from}${to ? '–'+to : '+'}<br/>`;
  }
  div.innerHTML = html;
  return div;
};
legend.addTo(map);

// Load and render logic
async function loadAndRender() {
  try {
    summaryEl.innerHTML = 'Loading…';
    const selected = stateSelect.value;
    const statesToFetch = (selected && selected !== 'ALL') ? [selected] : basinStates;

    let sites = await fetchUSGSForStates(statesToFetch);
    sites = dedupeSitesById(sites);

    // optional: limit for demo responsiveness
    // sites = sites.slice(0, 3000);

    // compute simple summary
    const numeric = sites.map(s => parseFloat(s.value)).filter(v => !isNaN(v));
    const mean = numeric.length ? (numeric.reduce((a,b)=>a+b,0)/numeric.length).toFixed(1) : 'n/a';
    const count = sites.length;

    summaryEl.innerHTML = `<p><strong>Gages:</strong> ${count}<br/><strong>Mean discharge (cfs):</strong> ${mean}</p><p>Click a marker for details and a 30-day sparkline.</p>`;

    if (toggleDischarge.checked) renderDischarge(sites);
    else dischargeLayer.clearLayers();
  } catch (err) {
    console.error(err);
    summaryEl.innerHTML = 'Error loading data. See console.';
  }
}

// Event listeners
toggleDischarge.addEventListener('change', () => {
  if (toggleDischarge.checked) map.addLayer(dischargeLayer);
  else map.removeLayer(dischargeLayer);
});
refreshBtn.addEventListener('click', loadAndRender);
stateSelect.addEventListener('change', loadAndRender);

// Initial load
loadAndRender();
