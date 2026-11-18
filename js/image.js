// Shrinks receipt photos in the browser before upload (phone photos are often 5 MB+).

function loadBitmap(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can read')); };
    img.src = url;
  });
}

function drawToBlob(src, maxSide, quality) {
  const w0 = src.width;
  const h0 = src.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the image'))), 'image/jpeg', quality);
  });
}

/** Returns { full, thumb } JPEG blobs: full is max 1600px, thumb is max 240px. */
export async function prepareReceipt(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image`);
  const bmp = await loadBitmap(file);
  const full = await drawToBlob(bmp, 1600, 0.8);
  const thumb = await drawToBlob(bmp, 240, 0.7);
  if (bmp.close) bmp.close();
  return { full, thumb };
}
