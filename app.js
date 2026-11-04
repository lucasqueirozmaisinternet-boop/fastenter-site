const UPDATE_BUCKET = "https://ljssdcvjpseqntdvmwdg.supabase.co/storage/v1/object/public/fastenter-updates";
const UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAx1UFiw9tOPHvZSjsePUmhvI6PwqqZCHZJUU3MDqDHdY=";
const MAX_CHUNK_SIZE = 40 * 1024 * 1024;
const MAX_PACKAGE_SIZE = 512 * 1024 * 1024;
const encoder = new TextEncoder();
const button = document.querySelector("#download-button");
const versionLabel = document.querySelector("#version-label");
const statusLabel = document.querySelector("#download-status");
const progressBar = document.querySelector("#download-progress");
let currentManifest;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function loadPublicKey() {
  return crypto.subtle.importKey("spki", decodeBase64(UPDATE_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("O manifesto publicado é inválido.");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("A versão publicada é inválida.");
  if (manifest.platform !== "win32-x64" || manifest.installer !== `FastEnter-Setup-v${manifest.version}.exe`) throw new Error("O pacote publicado não corresponde ao FastEnter para Windows x64.");
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_PACKAGE_SIZE) throw new Error("O tamanho do instalador publicado é inválido.");
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error("O checksum publicado é inválido.");
  if (typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature) || decodeBase64(manifest.signature).length !== 64) throw new Error("A assinatura do instalador é inválida.");
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > 16) throw new Error("A lista de partes do instalador é inválida.");
  let totalSize = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (!chunk || typeof chunk.path !== "string" || !/^[A-Za-z0-9._/-]+$/.test(chunk.path) || chunk.path.startsWith("/") || chunk.path.includes("\\") || chunk.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Um caminho de download publicado é inválido.");
    if (!chunk.path.startsWith(`${manifest.version}/`) || !chunk.path.endsWith(`.part${String(index + 1).padStart(3, "0")}`)) throw new Error("A ordem das partes do instalador é inválida.");
    if (!Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > MAX_CHUNK_SIZE) throw new Error("O tamanho de uma parte publicada é inválido.");
    totalSize += chunk.size;
  }
  if (totalSize !== manifest.size) throw new Error("As partes não correspondem ao tamanho informado para o instalador.");
  return manifest;
}

async function readBounded(response, limit, label, combine = true) {
  if (!response.body) throw new Error(`${label}: resposta sem conteúdo.`);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`${label}: o conteúdo excede o tamanho permitido.`);
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { parts, size, bytes: combine ? new Uint8Array(await new Blob(parts).arrayBuffer()) : undefined };
}

async function verifyManifestSignature(manifest) {
  const { signature, ...unsigned } = manifest;
  const key = await loadPublicKey();
  return crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64(signature), encoder.encode(canonicalJson(unsigned)));
}

function setFailure(message) {
  currentManifest = undefined;
  versionLabel.textContent = "Windows 10 e 11 · x64";
  statusLabel.textContent = message;
  button.disabled = true;
  button.textContent = "Download indisponível";
  const fallback = document.createElement("a");
  fallback.href = "https://github.com/lucasqueirozmaisinternet-boop/FastEnter/releases";
  fallback.target = "_blank";
  fallback.rel = "noopener noreferrer";
  fallback.className = "download-fallback";
  fallback.textContent = "Ver versões e novidades no GitHub ↗";
  document.querySelector(".download-info").after(fallback);
}

async function checkLatest() {
  try {
    if (!crypto?.subtle || !globalThis.isSecureContext) throw new Error("Abra esta página em HTTPS para validar o instalador com segurança.");
    const manifestUrl = new URL(`${UPDATE_BUCKET}/latest.json`);
    manifestUrl.searchParams.set("site", String(Date.now()));
    const response = await fetch(manifestUrl, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(response.status === 404 ? "Uma nova versão ainda não foi publicada." : `A publicação respondeu com o erro ${response.status}.`);
    const { bytes } = await readBounded(response, 64 * 1024, "Manifesto");
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
    if (!await verifyManifestSignature(manifest)) throw new Error("A assinatura oficial não confere. O download foi bloqueado.");
    currentManifest = manifest;
    versionLabel.textContent = `Versão ${manifest.version} · Windows x64`;
    statusLabel.textContent = `${manifest.releaseNotes || "Versão estável disponível."} · ${(manifest.size / 1024 / 1024).toFixed(0)} MB`;
    button.innerHTML = 'Baixar instalador <span aria-hidden="true">↓</span>';
    button.disabled = false;
  } catch (error) {
    const message = error instanceof TypeError && !globalThis.isSecureContext
      ? "Abra esta página em HTTPS para validar o instalador com segurança."
      : (error?.message || "Não foi possível conferir a versão mais recente.");
    setFailure(message);
  }
}

async function downloadLatest() {
  if (!currentManifest || button.disabled) return;
  const manifest = currentManifest;
  button.disabled = true;
  button.textContent = "Verificando download…";
  statusLabel.textContent = "Baixando partes do instalador…";
  progressBar.style.width = "0%";
  const parts = [];
  let total = 0;
  try {
    for (const [index, chunk] of manifest.chunks.entries()) {
      statusLabel.textContent = `Baixando parte ${index + 1} de ${manifest.chunks.length}…`;
      const path = chunk.path.split("/").map(encodeURIComponent).join("/");
      const url = new URL(`${UPDATE_BUCKET}/${path}`);
      if (url.origin !== new URL(UPDATE_BUCKET).origin) throw new Error("A origem do instalador não é permitida.");
      const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Não foi possível baixar a parte ${index + 1}.`);
      const bytes = await readBounded(response, chunk.size, `Parte ${index + 1}`, false);
      if (bytes.size !== chunk.size) throw new Error(`A parte ${index + 1} tem um tamanho diferente do esperado.`);
      parts.push(...bytes.parts);
      total += bytes.size;
      progressBar.style.width = `${Math.floor((total / manifest.size) * 85)}%`;
    }
    if (total !== manifest.size) throw new Error("O tamanho total do instalador está incorreto.");
    statusLabel.textContent = "Conferindo SHA-256 do instalador…";
    const installer = new Blob(parts, { type: "application/vnd.microsoft.portable-executable" });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await installer.arrayBuffer()));
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (sha256 !== manifest.sha256.toLowerCase()) throw new Error("O SHA-256 não confere. O download foi bloqueado.");
    const objectUrl = URL.createObjectURL(installer);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = manifest.installer;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    progressBar.style.width = "100%";
    statusLabel.textContent = "Download verificado. Confira o arquivo e siga as etapas do instalador.";
    button.innerHTML = 'Baixar novamente <span aria-hidden="true">↓</span>';
  } catch (error) {
    statusLabel.textContent = error?.message || "O download falhou e não foi liberado.";
    button.innerHTML = 'Tentar novamente <span aria-hidden="true">↻</span>';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", downloadLatest);
void checkLatest();
