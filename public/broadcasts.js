async function prepareBroadcastPhoto(file) {
  const limit = 2 * 1024 * 1024;
  if (file.size > 20 * 1024 * 1024) throw new Error('This image exceeds 20 MB. Choose a smaller image.');
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((v, i) => signature[i] === v);
  const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  if (!png && !jpeg) throw new Error('Choose a PNG or JPEG image. This file has a different format.');
  let blob = file, type = png ? 'image/png' : 'image/jpeg';
  const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read image')); reader.readAsDataURL(new Blob([file], {type})); });
  {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('This image could not be opened. Choose another PNG or JPEG.'); }
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw new Error('This image has too many pixels. Choose an image under 40 megapixels.');
    if (file.size > limit || Math.max(img.naturalWidth, img.naturalHeight) > 1600) {
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Image processing is unavailable. Please choose an image under 2 MB.');
      ctx.fillStyle = '#0c1811'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.8, 0.65]) {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= limit) break;
      }
      if (!blob || blob.size > limit) throw new Error('Unable to reduce this image below 2 MB. Choose a smaller image.');
      type = 'image/jpeg';
    }
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read image')); reader.readAsDataURL(blob); });
    return { type, base64: data.split(',')[1] };
  }
}

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
  function updatePhotoPicker() {
    const file = $('broadcast-photo').files[0];
    $('broadcast-photo-label').textContent = file ? file.name : 'Add a photo';
    $('broadcast-photo-details').textContent = file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Tap to change` : 'Optional · PNG or JPG · Up to 20 MB';
    $('broadcast-photo-remove').hidden = !file;
  }
  $('broadcast-photo').addEventListener('change', updatePhotoPicker);
  $('broadcast-photo-remove').onclick = () => {
    $('broadcast-photo').value = ''; requestKey = null; updatePhotoPicker(); $('broadcast-photo').focus();
  };
  $('broadcast-form').onsubmit = event => {
    event.preventDefault();
    run($('broadcast-preview-button'), async () => {
      const current = generation;
      const text = $('broadcast-text').value;
      const file = $('broadcast-photo').files[0];
      let photo = null;
      if (file) {
        if (text.trim().length > 1024) throw new Error('Image captions can contain up to 1024 characters.');
        photo = await prepareBroadcastPhoto(file);
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
    updatePhotoPicker();
    $('broadcast-copy').textContent = ''; $('broadcast-image').removeAttribute('src');
  }
  $('broadcast-new').onclick = resetDraft;
  return { reset() {
    generation++; clearInterval(timer); $('broadcast-dialog').close(); $('broadcast-open').hidden = true;
    resetDraft(); $('broadcast-history').replaceChildren(); $('broadcast-audience').textContent = ''; $('broadcast-error').textContent = '';
  } };
}
