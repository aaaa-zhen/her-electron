/* --- Image handling (paste, upload, lightbox) --- */

let pastedImages = [];

function arrayBufferFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function buildStoredImageName(image, index) {
  const baseName = (image.name || "").trim().replace(/[^\w.\-\u4e00-\u9fff]+/g, "_");
  if (baseName) return baseName;
  return `her-image-${Date.now()}-${index + 1}.${extFromMediaType(image.mediaType)}`;
}

async function persistPastedImages(images) {
  const persisted = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const upload = await window.herAPI.uploadFile({
      name: buildStoredImageName(image, index),
      type: image.mediaType,
      data: arrayBufferFromBase64(image.base64),
    });
    persisted.push({ ...image, filename: upload.filename, size: upload.size });
  }
  return persisted;
}

function addPastedImage(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const dataUrl = event.target.result;
    const mediaType = ALLOWED_IMAGE_TYPES.has(file.type) ? file.type : "image/png";
    const base64 = dataUrl.split(",")[1];
    const id = Date.now() + Math.random();
    const fallbackName = file && file.name ? file.name : `pasted-${Date.now()}.${extFromMediaType(mediaType)}`;
    pastedImages.push({ id, base64, mediaType, dataUrl, name: fallbackName });

    const imgPreviews = document.getElementById("img-previews");
    const item = document.createElement("div");
    item.className = "img-preview-item";
    item.innerHTML = `<img src="${dataUrl}"><button class="img-preview-remove">✕</button>`;
    item.querySelector(".img-preview-remove").onclick = () => {
      pastedImages = pastedImages.filter((image) => image.id !== id);
      item.remove();
      updateSendBtn();
    };
    imgPreviews.appendChild(item);
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

function openLightbox(src) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox").classList.add("open");
}

function getPastedImages() {
  return pastedImages;
}

function clearPastedImages() {
  pastedImages = [];
}
