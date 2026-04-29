# Water Tracker MVP

Simple static demo showing USGS streamflow gages on a Leaflet map.

## How to use

1. Create a new GitHub repository and push these files.
2. In the repo settings enable GitHub Pages from the `main` branch root.
3. Open the published URL to view the demo.

## Notes

- The demo queries USGS Water Services for instantaneous discharge (parameter 00060).
- To demo other data sources add new fetch functions and render layers.
- For production use add caching (serverless function) to avoid CORS and rate limits.
