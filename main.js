// main.js - Blackford Water interactive map (USGS streamflow) with Colorado River Basin support and 30-day sparkline popups
// Requires: Leaflet (already in index.html) and Chart.js (add CDN <script src="https://cdn.jsdelivr.net/npm/chart.js"></script> in index.html)

const basinStates = ['CO', 'NM', 'WY', 'UT', 'AZ', 'NV', 'CA'];

// Map initialization centered over the Colorado River Basin
const map = L.map('map').setView([37.0, -111.5], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let dischargeLayer = L.layerGroup().addTo(map);
const summaryEl = document.getElementById('summary');
const stateSelect = document.getElementById('state-select');
const toggleDischarge = document.getElementById('toggle-discharge');
const refreshBtn = document.getElementById('refresh-btn');

// Helper: fetch instantaneous values for a single state (parameter 00060 = discharge cfs)
async function fetchUSGSInstant(stateCd='UT') {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=${stateCd}&parameterCd=00060&siteStatus=active`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS fetch failed for ${stateCd}`);
  return res.json();
}

// Fetch multiple states in parallel and combine results
async function fetchUSGSForStates(stateCodes) {
  const promises = stateCodes.map(code =>
    fetchUSGSInstant(code).catch(e => {
      console.error('USGS fetch error for', code, e);
      return null;
    })
  );
  const results = await Promise.all(promises);
  const allSites = [];
  for (const raw of results) {
    if (!raw) continue;
    const sites = parseUSGS(raw);
    allSites.push(...sites);
  }
  return allSites;
}

// Parse USGS JSON into a simple site array
function parseUSGS(data) {
  const sites = [];
  const timeSeries = (data && data.value && data.value.timeSeries) || [];
  for (const ts of timeSeries) {
    const sourceInfo = ts.sourceInfo || {};
    const siteCode = sourceInfo.siteCode && sourceInfo.siteCode[0] && sourceInfo.siteCode[0].value;
    const name = sourceInfo.siteName || 'Unknown';
    const geo = sourceInfo.geoLocation && sourceInfo.geoLocation.geogLocation;
    const lat = geo && geo.latitude;
    const lon = geo && geo.longitude;
    const values = ts.values && ts.values[0] && ts.values[0].value;
    const last = values && values.length ? values[values.length - 1] : null;
    const value = last ? last.value : null;
    const time = last ? last.dateTime : null;
    const unit = ts.variable && ts.variable.unit && ts.variable.unit.unitCode;
    const siteUrl = siteCode ? `https://waterdata.usgs.gov/nwis/uv?site_no=${siteCode}` : '#';
    if (siteCode && lat && lon) {
      sites.push({ id: siteCode, name, lat, lon, value, unit, time, siteUrl });
    }
  }
  return sites;
}

// Render discharge markers with popups and a 30-day sparkline (Chart.js)
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

    // create a unique canvas id for the sparkline
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

    // When popup opens, fetch 30-day daily values and draw the chart
    marker.on('popupopen', async () => {
      try {
        // small delay to ensure DOM canvas is present
        await wait(50);
        const data = await fetchUSGSDaily(s.id, 30);
        if (!data || !data.length) return;
        const labels = data.map(d => d.date);
        const vals = data.map(d => d.value);
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        // destroy existing chart instance on the canvas if present
        if (ctx._chartInstance) {
          try { ctx._chartInstance.destroy(); } catch (e) { /* ignore */ }
        }
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
            scales: {
              x: { display: false },
              y: { display: true, ticks: { maxTicksLimit: 4 } }
            },
            elements: { line: { borderWidth: 1.5 } }
          }
        });
      } catch (e) {
        console.error('Error rendering sparkline for', s.id, e);
      }
    });

    // update sidebar summary when marker clicked
    marker.on('click', () => {
      summaryEl.innerHTML = `<p><strong>${escapeHtml(s.name)}</strong><br/>Latest discharge ${s.value ?? 'n/a'} ${s.unit ?? ''}<br/>Time ${s.time ?? 'n/a'}</p><p><a href="${s.siteUrl}" target="_blank" rel="noopener">Open USGS site page</a></p>`;
    });

    marker.addTo(dischargeLayer);
  }
}

// Utility: create canvas HTML for sparkline
function createSparklineCanvas(id) {
  // fixed size to keep popups compact
  return `<div style="width:100%;height:80px;margin-top:6px"><canvas id="${id}" width="300" height="80"></canvas></div>`;
}

// Fetch last N days of daily values (dv) for a site
async function fetchUSGSDaily(siteId, days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const startStr = start.toISOString().slice(0,10);
  const endStr = end.toISOString().slice(0,10);
  const url = `https://waterservices.usgs.gov/nwis/dv/?format=json&sites=${siteId}&startDT=${startStr}&endDT=${endStr}&parameterCd=00060`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn('USGS daily fetch failed for', siteId);
    return null;
  }
  const data = await res.json();
  const ts = data.value && data.value.timeSeries && data.value.timeSeries[0];
  if (!ts || !ts.values || !ts.values[0]) return null;
  const values = ts.values[0].value.map(v => ({
    date: v.dateTime.slice(0,10),
    value: v.value === '' ? null : parseFloat(v.value)
  }));
  return values;
}

// Color ramp for discharge values
function getColorByValue(v) {
  if (isNaN(v)) return '#999';
  if (v < 10) return '#2b83ba';
  if (v < 100) return '#abdda4';
  if (v < 500) return '#fdae61';
  return '#d7191c';
}

// Load and render logic: if a single state is selected, fetch that state; otherwise fetch all basin states.
// Note: to trigger "all states" behavior, add an option in your <select id="state-select"> with value="ALL".
async function loadAndRender() {
  try {
    summaryEl.innerHTML = 'Loading data...';
    const selected = (stateSelect && stateSelect.value) || '';
    const statesToFetch = (selected && selected !== 'ALL') ? [selected] : basinStates;
    const sites = await fetchUSGSForStates(statesToFetch);
    summaryEl.innerHTML = `Loaded ${sites.length} streamflow gages for ${statesToFetch.join(', ')}. Click a marker for details.`;
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

// Utility helpers
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Initial load
loadAndRender();
