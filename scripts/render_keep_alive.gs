/** Call this from a time-driven Google Apps Script trigger every 10 minutes. */
function keepRenderAwake() {
  const healthUrl = 'https://YOUR-SERVICE.onrender.com/health';
  const response = UrlFetchApp.fetch(healthUrl, {muteHttpExceptions: true});
  if (response.getResponseCode() !== 200) {
    throw new Error(`Render health check failed: ${response.getResponseCode()}`);
  }
}
