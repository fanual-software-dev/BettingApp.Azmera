function setupBroadcasts({ $, api, node }) {
  let draft = null, requestKey = null, timer = null, generation = 0;
  async function run(button, fn) {
    button.disabled = true; $('broadcast-error').textContent = '';
    try { await fn(); } catch (error) { $('broadcast-error').textContent = error.message; }
    finally { button.disabled = button.id === 'broadcast-send' ? draft?.status !== 'draft' : false; }
  }
  async function history() {
    const current = generation;
    const data = await api('/api/admin/broadcasts');
    if (current !== generation) return;
    $('broadcast-audience').textContent = `${data.recipients} active recipients`;
    $('broadcast-history').replaceChildren();
    for (const job of data.jobs) {
      const card = node('section', '', 'panel');
      card.append(node('strong', `${new Date(job.created).toLocaleString()} · ${job.status}`), node('p', job.content.slice(0, 100)));
      card.append(node('p', Object.entries(job.counts).map(([status, count]) => `${status}: ${count}`).join(' · ')));
      if (job.status === 'draft') {
        const button = node('button', 'Review draft', 'secondary');
        button.onclick = () => run(button, async () => {
          const current = generation;
          const value = await api(`/api/admin/broadcasts/${job.id}`);
          if (current === generation) preview(value);
        });
        card.append(button);
      }
      $('broadcast-history').append(card);
    }
  }
  function preview(value) {
    draft = value;
    $('broadcast-form').hidden = true; $('broadcast-preview').hidden = false;
    $('broadcast-copy').textContent = value.text;
    $('broadcast-recipient-count').textContent = `Send this announcement to ${value.recipients} recipients?`;
    $('broadcast-image').hidden = !value.photo;
    $('broadcast-image').removeAttribute('src');
    if (value.photo) $('broadcast-image').src = `data:${value.photo.type};base64,${value.photo.base64}`;
    $('broadcast-send').disabled = value.status !== 'draft' || !value.recipients;
  }
  $('broadcast-open').onclick = () => {
    $('broadcast-dialog').showModal();
    run($('broadcast-refresh'), history);
    clearInterval(timer);
    timer = setInterval(() => { if (!$('broadcast-refresh').disabled) run($('broadcast-refresh'), history); }, 5000);
  };
  $('broadcast-dialog').addEventListener('close', () => clearInterval(timer));
  $('broadcast-refresh').onclick = () => run($('broadcast-refresh'), history);
  $('broadcast-form').addEventListener('input', () => { requestKey = null; });
  $('broadcast-form').onsubmit = event => {
    event.preventDefault();
    run($('broadcast-preview-button'), async () => {
      const current = generation;
      const text = $('broadcast-text').value;
      const file = $('broadcast-photo').files[0];
      let photo = null;
      if (file) {
        if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Choose a PNG or JPEG image up to 2 MB.');
        if (text.trim().length > 1024) throw new Error('Image captions can contain up to 1024 characters.');
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read image')); reader.readAsDataURL(file); });
        photo = { type: file.type, base64: data.split(',')[1] };
      }
      requestKey ||= crypto.randomUUID();
      const value = await api('/api/admin/broadcasts', { text, photo }, requestKey);
      if (current === generation) { preview(value); await history(); }
    });
  };
  $('broadcast-send').onclick = () => run($('broadcast-send'), async () => {
    if (!draft || draft.status !== 'draft') return;
    const current = generation;
    await api(`/api/admin/broadcasts/${draft.id}/send`, { confirm: true });
    if (current !== generation) return;
    draft.status = 'queued';
    $('broadcast-recipient-count').textContent = 'Queued. You can close this window; delivery continues on the server.';
    await history();
  });
  function resetDraft() {
    draft = null; requestKey = null;
    $('broadcast-form').reset(); $('broadcast-form').hidden = false; $('broadcast-preview').hidden = true;
    $('broadcast-copy').textContent = ''; $('broadcast-image').removeAttribute('src');
  }
  $('broadcast-new').onclick = resetDraft;
  return { reset() {
    generation++; clearInterval(timer); $('broadcast-dialog').close(); $('broadcast-open').hidden = true;
    resetDraft(); $('broadcast-history').replaceChildren(); $('broadcast-audience').textContent = ''; $('broadcast-error').textContent = '';
  } };
}
