document.addEventListener('DOMContentLoaded', async () => {
  const input = document.getElementById('apiKey');
  const toggleVis = document.getElementById('toggleVis');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');

  const stored = await chrome.storage.sync.get('pylonApiKey');
  if (stored.pylonApiKey) input.value = stored.pylonApiKey;

  toggleVis.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  saveBtn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      showStatus('Enter an API key first.', '#e87878');
      return;
    }
    await chrome.storage.sync.set({ pylonApiKey: key });
    showStatus('Saved! Dashboard will refresh shortly.', '#50c878');
  });

  function showStatus(msg, color = '#50c878') {
    status.textContent = msg;
    status.style.color = color;
    status.style.opacity = '1';
    setTimeout(() => { status.style.opacity = '0'; }, 2500);
  }
});
