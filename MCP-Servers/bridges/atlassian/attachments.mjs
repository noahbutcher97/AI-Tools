import { createHash, randomUUID } from "node:crypto";
import { access, link, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DOWNLOAD_HOST_SUFFIXES = [".atlassian.com", ".atlassian.net", ".atl-paas.net"];
const MAX_REDIRECTS = 3;

const MEDIA_TYPES = new Map([
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

function normalizeHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256 digest");
  }
  return value.toLowerCase();
}

function validateMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  return value;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeMediaType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function mediaTypeForPath(filePath) {
  return MEDIA_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream";
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) ?? null;
}

function httpError(response, message) {
  return Object.assign(new Error(message), {
    status: response.status, retryAfter: responseHeader(response, "retry-after"),
  });
}

async function responseBytes(response, maxBytes) {
  const declared = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Attachment exceeds maxBytes (${declared} > ${maxBytes})`);
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Attachment exceeds maxBytes (${total} > ${maxBytes})`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`Attachment exceeds maxBytes (${bytes.length} > ${maxBytes})`);
  }
  return bytes;
}

export class AttachmentTransfer {
  constructor({
    baseUrl,
    authorization,
    allowedRoots,
    fetchImpl,
    openFileImpl = open,
    unlinkFileImpl = unlink,
    warnImpl = (message) => console.error(message),
    timeoutMs = 30_000,
  }) {
    this.baseUrl = new URL(baseUrl);
    this.authorization = authorization;
    this.allowedRoots = Array.isArray(allowedRoots) ? allowedRoots.map((root) => resolve(root)) : [];
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.openFile = openFileImpl;
    this.unlinkFile = unlinkFileImpl;
    this.warn = warnImpl;
    this.timeoutMs = timeoutMs;
  }

  async upload({ issueKey, filePath, expectedSha256, maxBytes }) {
    const expectedHash = normalizeHash(expectedSha256);
    const limit = validateMaxBytes(maxBytes);
    const safePath = await this._existingPath(filePath, "filePath");
    const fileStats = await stat(safePath);
    if (!fileStats.isFile()) throw new Error("filePath must identify a regular file");
    if (fileStats.size > limit) {
      throw new Error(`Attachment exceeds maxBytes (${fileStats.size} > ${limit})`);
    }

    const { bytes, sha256: actualHash } = await this._readLocalFile(safePath, limit);
    if (actualHash !== expectedHash) {
      throw new Error(`Attachment SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    const filename = basename(safePath);
    const mimeType = mediaTypeForPath(filename);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    const url = this._jiraUrl(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`);
    const attachment = await this._request(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    }, async (response) => {
      if (!response.ok) {
        throw httpError(response, `Atlassian attachment upload ${response.status}: ${await this._boundedError(response)}`);
      }
      const data = await response.json();
      return Array.isArray(data) ? data[0] : null;
    }, { ambiguousWrite: true });

    if (!attachment?.id) {
      throw new Error("Atlassian attachment upload returned no receipt; remote state is ambiguous");
    }
    if (attachment.filename !== filename) {
      throw new Error("Attachment upload filename mismatch; remote state is ambiguous");
    }
    if (attachment.size !== bytes.length) {
      throw new Error("Attachment upload size mismatch; remote state is ambiguous");
    }
    if (normalizeMediaType(attachment.mimeType) !== mimeType) {
      throw new Error("Attachment upload media type mismatch; remote state is ambiguous");
    }

    return { id: String(attachment.id), filename, size: bytes.length, sha256: actualHash };
  }

  async download({ attachmentId, destinationPath, expectedSha256, maxBytes }) {
    const expectedHash = normalizeHash(expectedSha256);
    const limit = validateMaxBytes(maxBytes);
    const safeDestination = await this._newDestination(destinationPath);
    const metadataUrl = this._jiraUrl(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`);
    const metadata = await this._request(metadataUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: this.authorization, Accept: "application/json" },
    }, async (response) => {
      if (!response.ok) {
        throw httpError(response, `Atlassian attachment metadata ${response.status}: ${await this._boundedError(response)}`);
      }
      return response.json();
    });
    if (Number.isFinite(metadata.size) && metadata.size > limit) {
      throw new Error(`Attachment exceeds maxBytes (${metadata.size} > ${limit})`);
    }

    let currentUrl = this._jiraUrl(metadata.content);
    let includeAuthorization = true;
    let downloaded;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const headers = includeAuthorization
        ? { Authorization: this.authorization, Accept: "*/*" }
        : { Accept: "*/*" };
      const result = await this._request(
        currentUrl,
        { method: "GET", redirect: "manual", headers },
        async (response) => {
          if (response.status >= 300 && response.status < 400) {
            return { redirect: responseHeader(response, "location") };
          }
          if (!response.ok) {
            throw httpError(response, `Atlassian attachment download ${response.status}: ${await this._boundedError(response)}`);
          }
          return {
            bytes: await responseBytes(response, limit),
            mediaType: normalizeMediaType(responseHeader(response, "content-type")),
          };
        },
      );
      if (!Object.hasOwn(result, "redirect")) {
        downloaded = result;
        break;
      }
      if (redirects === MAX_REDIRECTS) throw new Error("Attachment download exceeded redirect limit");
      if (!result.redirect) throw new Error("Attachment download redirect omitted Location");
      currentUrl = this._downloadRedirectUrl(result.redirect, currentUrl);
      includeAuthorization = false;
    }

    if (!downloaded) throw new Error("Attachment download returned no bytes");
    const responseType = downloaded.mediaType;
    const metadataType = normalizeMediaType(metadata.mimeType);
    const markdownAsText = metadataType === "text/markdown" && responseType === "text/plain";
    if (!responseType || !metadataType || (responseType !== metadataType && !markdownAsText)) {
      throw new Error(`Attachment media type mismatch: metadata ${metadataType || "missing"}, response ${responseType || "missing"}`);
    }
    const bytes = downloaded.bytes;
    if (Number.isFinite(metadata.size) && metadata.size !== bytes.length) {
      throw new Error(`Attachment size mismatch: metadata ${metadata.size}, received ${bytes.length}`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Attachment SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    await this._atomicWrite(safeDestination, bytes);
    return { path: safeDestination, bytes: bytes.length, sha256: actualHash };
  }

  _jiraUrl(path) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || url.username || url.password || url.hash) {
      throw new Error("Authenticated request URL must stay on the configured Jira origin");
    }
    return url;
  }

  _downloadRedirectUrl(location, currentUrl) {
    const url = new URL(location, currentUrl);
    const hostname = url.hostname.toLowerCase();
    const trustedHost = url.origin === this.baseUrl.origin
      || DOWNLOAD_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    if (url.protocol !== "https:" || (url.port && url.port !== "443")
      || url.username || url.password || url.hash || !trustedHost) {
      throw new Error("Attachment download redirect destination is not trusted");
    }
    return url;
  }

  async _rootPaths() {
    if (this.allowedRoots.length === 0) throw new Error("No attachment file roots are configured");
    return Promise.all(this.allowedRoots.map((root) => realpath(root)));
  }

  // Canonicalization blocks paths that already escape through symlinks. The
  // configured roots and their ancestors are a local trust boundary: callers
  // must keep them stable while a transfer runs. Node does not expose openat-
  // style directory handles that could contain a hostile process replacing an
  // already-validated ancestor between realpath and a later path operation.

  async _existingPath(filePath, label) {
    if (!isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
    const candidate = await realpath(filePath);
    const roots = await this._rootPaths();
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new Error(`${label} is outside configured roots`);
    }
    return candidate;
  }

  async _newDestination(destinationPath) {
    if (!isAbsolute(destinationPath)) throw new Error("destinationPath must be an absolute path");
    const parent = await realpath(dirname(destinationPath));
    const candidate = join(parent, basename(destinationPath));
    const roots = await this._rootPaths();
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new Error("destinationPath is outside configured roots");
    }
    try {
      await access(candidate);
      throw new Error("destinationPath already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return candidate;
  }

  async _readLocalFile(filePath, maxBytes) {
    const handle = await this.openFile(filePath, "r");
    try {
      const chunks = [];
      const hash = createHash("sha256");
      let total = 0;
      let position = 0;
      while (true) {
        const readSize = Math.min(64 * 1024, maxBytes - total + 1);
        const buffer = Buffer.allocUnsafe(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, position);
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > readSize) {
          throw new Error("Attachment file read returned an invalid byte count");
        }
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new Error(`Attachment exceeds maxBytes (${total} > ${maxBytes})`);
        const chunk = buffer.subarray(0, bytesRead);
        chunks.push(chunk);
        hash.update(chunk);
        position += bytesRead;
      }
      return { bytes: Buffer.concat(chunks, total), sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  }

  async _atomicWrite(destinationPath, bytes) {
    const tempPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await link(tempPath, destinationPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.unlinkFile(tempPath).catch(() => {});
      throw error;
    }

    await this._cleanupPublishedTemp(tempPath);
  }

  async _cleanupPublishedTemp(tempPath) {
    let cleanupError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.unlinkFile(tempPath);
        return;
      } catch (error) {
        cleanupError = error;
      }
    }

    const code = typeof cleanupError?.code === "string" && /^[A-Z0-9_]+$/.test(cleanupError.code)
      ? cleanupError.code
      : "UNKNOWN";
    try {
      this.warn(`[atlassian-bridge] Attachment destination published, but temporary-file cleanup failed (${code}).`);
    } catch {
      // A diagnostic sink must not turn a committed destination into a failed download.
    }
  }

  async _request(url, options, consume, { ambiguousWrite = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request timed out")), this.timeoutMs);
    try {
      const response = await this.fetch(url.toString(), { ...options, signal: controller.signal });
      return await consume(response);
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (ambiguousWrite) {
        const cause = timedOut ? "timed out" : `failed: ${error.message}`;
        throw Object.assign(new Error(`Attachment upload ${cause}; remote state is ambiguous and must be checked before retrying`),
          { status: timedOut ? null : error.status, retryAfter: timedOut ? null : error.retryAfter });
      }
      if (timedOut) throw new Error("Attachment request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _boundedError(response) {
    const bytes = await responseBytes(response, 16 * 1024).catch(() => Buffer.from("response too large"));
    return bytes.toString("utf8").slice(0, 1000);
  }
}
