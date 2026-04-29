// main.js - simple Leaflet map + USGS instantaneous values by state
const map = L.map('map').setView([40.76, -111.89], 7); // default Salt Lake City view

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let dischargeLayer = L.layerGroup().addTo(map);
const summaryEl = document.getElementById('summary');
const stateSelect = document.getElementById('state-select');
const toggleDischarge = document.getElementById('toggle-discharge');
const refreshBtn = document.getElementById('refresh-btn');

async function fetchUSGSInstant(stateCd='UT') {
  // parameterCd=00060 is discharge (cfs); format=json
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=${stateCd}&parameterCd=00060&siteStatus=active`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('USGS fetch failed');
  const data = await res.json();
  return data;
}

function parseUSGS(data) {
  // returns array of { id, name, lat, lon, value, unit, time, siteUrl }
  const sites = [];
  const timeSeries = data.value.timeSeries || [];
  for (const ts of timeSeries) {
    const sourceInfo = ts.sourceInfo || {};
    const siteCode = sourceInfo.siteCode && sourceInfo.siteCode[0] && sourceInfo.siteCode[0].value;
    const name = sourceInfo.siteName;
    const lat = sourceInfo.geoLocation && sourceInfo.geoLocation.geogLocation && sourceInfo.geoLocation.geogLocation.latitude;
    const lon = sourceInfo.geoLocation && sourceInfo.geoLocation.geogLocation && sourceInfo.geoLocation.geogLocation.longitude;
    const values = ts.values && ts.values[0] && ts.values[0].value;
    const last = values && values.length ? values[values.length - 1] : null;
    const value = last ? last.value : null;
    const time = last ? last.dateTime : null;
    const unit = ts.variable && ts.variable.unit && ts.variable.unit.unitCode;
    const siteUrl = `https://waterdata.usgs.gov/nwis/uv?site_no=${siteCode}`;
    if (siteCode && lat && lon) {
      sites.push({ id: siteCode, name, lat, lon, value, unit, time, siteUrl });
    }
  }
  return sites;
}

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
    const popupHtml = `
      <strong>${s.name}</strong><br/>
      <b>Site</b>: ${s.id}<br/>
      <b>Discharge</b>: ${s.value ?? 'n/a'} ${s.unit ?? ''}<br/>
      <b>Time</b>: ${s.time ?? 'n/a'}<br/>
      <a href="${s.siteUrl}" target="_blank">USGS site page</a>
    `;
    marker.bindPopup(popupHtml);
    marker.on('click', () => {
      summaryEl.innerHTML = `<p><strong>${s.name}</strong><br/>Latest discharge ${s.value ?? 'n/a'} ${s.unit ?? ''}<br/>Time ${s.time ?? 'n/a'}</p><p><a href="${s.siteUrl}" target="_blank">Open USGS site page</a></p>`;
    });
    marker.addTo(dischargeLayer);
  }
}

function getColorByValue(v) {
  // simple ramp: low blue -> high red
  if (isNaN(v)) return '#999';
  if (v < 10) return '#2b83ba';
  if (v < 100) return '#abdda4';
  if (v < 500) return '#fdae61';
  return '#d7191c';
}

async function loadAndRender() {
  try {
    const state = stateSelect.value || 'UT';
    summaryEl.innerHTML = 'Loading data...';
    const raw = await fetchUSGSInstant(state);
    const sites = parseUSGS(raw);
    summaryEl.innerHTML = `Loaded ${sites.length} streamflow gages for ${state}. Click a marker for details.`;
    if (toggleDischarge.checked) renderDischarge(sites);
  } catch (err) {
    console.error(err);
    summaryEl.innerHTML = 'Error loading data. See console.';
  }
}

toggleDischarge.addEventListener('change', () => {
  if (toggleDischarge.checked) map.addLayer(dischargeLayer);
  else map.removeLayer(dischargeLayer);
});

refreshBtn.addEventListener('click', loadAndRender);
stateSelect.addEventListener('change', loadAndRender);

// initial load
loadAndRender();
