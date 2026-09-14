import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { AttachmentTransfer } from "./attachments.mjs";

const AUTH = "Basic test-auth";
const BASE_URL = "https://example.atlassian.net";

test("attachment HTTP failures carry status and Retry-After without retrying uploads", async () => {
  await withTempRoots(async ({ allowed }) => {
    const filePath = join(allowed, "bounded.pdf");
    const bytes = Buffer.from("fictional bytes");
    await writeFile(filePath, bytes);
    let calls = 0;
    const transfer = new AttachmentTransfer({ baseUrl: BASE_URL, authorization: AUTH,
      allowedRoots: [allowed], fetchImpl: async () => {
        calls++;
        return jsonResponse(429, {}, { "retry-after": "45" });
      } });
    await assert.rejects(transfer.upload({ issueKey: "TEST-1", filePath,
      expectedSha256: sha256(bytes), maxBytes: 1024 }), error => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, "45");
      return true;
    });
    assert.equal(calls, 1);
  });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withTempRoots(fn) {
  const parent = await mkdtemp(join(tmpdir(), "atlassian-attachment-test-"));
  const allowed = join(parent, "allowed");
  const outside = join(parent, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  try {
    await fn({ parent, allowed, outside });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("upload sends verified bytes as multipart form data and returns a narrow receipt", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("fictional review packet");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, bytes);
    let captured;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async (url, options) => {
        captured = { url: String(url), options };
        return jsonResponse(200, [{ id: "7001", filename: "review.pdf", size: bytes.length, mimeType: "application/pdf" }]);
      },
    });

    const receipt = await transfer.upload({
      issueKey: "TEST-1",
      filePath,
      expectedSha256: sha256(bytes),
      maxBytes: 1024,
    });

    assert.equal(captured.url, `${BASE_URL}/rest/api/3/issue/TEST-1/attachments`);
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Authorization, AUTH);
    assert.equal(captured.options.headers["X-Atlassian-Token"], "no-check");
    assert.ok(captured.options.body instanceof FormData);
    assert.equal(captured.options.body.get("file").name, "review.pdf");
    assert.equal(await captured.options.body.get("file").text(), bytes.toString());
    assert.deepEqual(receipt, { id: "7001", filename: "review.pdf", size: bytes.length, sha256: sha256(bytes) });
  });
});

test("upload hashes all bytes when the file handle returns bounded partial reads", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("abcdef");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, "xx");
    const chunks = [Buffer.from("ab"), Buffer.from("cd"), Buffer.from("ef"), Buffer.alloc(0)];
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      openFileImpl: async () => ({
        async read(buffer) {
          const chunk = chunks.shift();
          chunk.copy(buffer);
          return { bytesRead: chunk.length, buffer };
        },
        async close() {},
      }),
      fetchImpl: async () => jsonResponse(200, [{
        id: "7001",
        filename: "review.pdf",
        size: bytes.length,
        mimeType: "application/pdf",
      }]),
    });

    const receipt = await transfer.upload({
      issueKey: "TEST-1",
      filePath,
      expectedSha256: sha256(bytes),
      maxBytes: 1024,
    });

    assert.equal(receipt.size, bytes.length);
    assert.equal(receipt.sha256, sha256(bytes));
  });
});

test("upload rejects bytes whose hash does not match before making a request", async () => {
  await withTempRoots(async ({ allowed }) => {
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, "wrong bytes");
    let calls = 0;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async () => { calls += 1; return jsonResponse(500, {}); },
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath, expectedSha256: "0".repeat(64), maxBytes: 1024 }),
      /SHA-256 mismatch/,
    );
    assert.equal(calls, 0);
  });
});

test("upload rejects a file larger than maxBytes before making a request", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("too large");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, bytes);
    let calls = 0;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async () => { calls += 1; return jsonResponse(500, {}); },
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath, expectedSha256: sha256(bytes), maxBytes: 3 }),
      /exceeds maxBytes/,
    );
    assert.equal(calls, 0);
  });
});

test("upload rejects a server receipt whose media type does not match the file", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("pdf bytes");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, bytes);
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async () => jsonResponse(200, [{
        id: "7001",
        filename: "review.pdf",
        size: bytes.length,
        mimeType: "text/plain",
      }]),
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath, expectedSha256: sha256(bytes), maxBytes: 1024 }),
      /media type mismatch.*remote state is ambiguous/i,
    );
  });
});

test("upload rejects out-of-root and symlink-escaped paths", async () => {
  await withTempRoots(async ({ allowed, outside }) => {
    const outsideFile = join(outside, "outside.pdf");
    await writeFile(outsideFile, "outside");
    const escape = join(allowed, "escape");
    await symlink(outside, escape, "junction");
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async () => jsonResponse(500, {}),
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath: outsideFile, expectedSha256: sha256("outside"), maxBytes: 1024 }),
      /outside configured roots/,
    );
    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath: join(escape, basename(outsideFile)), expectedSha256: sha256("outside"), maxBytes: 1024 }),
      /outside configured roots/,
    );
  });
});

test("upload timeout reports an ambiguous remote write and is never retried", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("packet");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, bytes);
    let calls = 0;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath, expectedSha256: sha256(bytes), maxBytes: 1024 }),
      /timed out.*remote state is ambiguous/i,
    );
    assert.equal(calls, 1);
  });
});

test("upload timeout remains active while reading its response receipt", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("packet");
    const filePath = join(allowed, "review.pdf");
    await writeFile(filePath, bytes);
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => ({
        ok: true,
        status: 200,
        async json() {
          return new Promise((_resolve, reject) => {
            const fallback = setTimeout(() => reject(new Error("receipt stalled without an active timeout")), 25);
            signal.addEventListener("abort", () => {
              clearTimeout(fallback);
              reject(signal.reason);
            }, { once: true });
          });
        },
      }),
    });

    await assert.rejects(
      () => transfer.upload({ issueKey: "TEST-1", filePath, expectedSha256: sha256(bytes), maxBytes: 1024 }),
      /timed out.*remote state is ambiguous/i,
    );
  });
});

test("download rejects an untrusted absolute content URL before requesting it", async () => {
  await withTempRoots(async ({ allowed }) => {
    const calls = [];
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async (url) => {
        calls.push(String(url));
        return jsonResponse(200, {
          id: "7001",
          filename: "review.pdf",
          size: 3,
          mimeType: "application/pdf",
          content: "https://evil.example/steal",
        });
      },
    });

    await assert.rejects(
      () => transfer.download({ attachmentId: "7001", destinationPath: join(allowed, "review.pdf"), expectedSha256: sha256("pdf"), maxBytes: 1024 }),
      /configured Jira origin/,
    );
    assert.equal(calls.length, 1);
  });
});

test("download validates a cross-origin redirect and omits Jira credentials", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("downloaded pdf");
    const calls = [];
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith("/rest/api/3/attachment/7001")) {
          return jsonResponse(200, {
            id: "7001",
            filename: "review.pdf",
            size: bytes.length,
            mimeType: "application/pdf",
            content: `${BASE_URL}/rest/api/3/attachment/content/7001`,
          });
        }
        if (String(url).includes("/attachment/content/7001")) {
          // The native Jira content route negotiates the attachment's actual
          // media type and returns 406 for application/octet-stream alone.
          if (options.headers.Accept !== "*/*") return new Response(null, { status: 406 });
          return new Response(null, {
            status: 302,
            headers: { location: "https://api.media.atlassian.com/file/7001" },
          });
        }
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": String(bytes.length) },
        });
      },
    });
    const destinationPath = join(allowed, "review.pdf");

    const receipt = await transfer.download({
      attachmentId: "7001",
      destinationPath,
      expectedSha256: sha256(bytes),
      maxBytes: 1024,
    });

    assert.equal(calls[0].options.headers.Authorization, AUTH);
    assert.equal(calls[1].options.headers.Authorization, AUTH);
    assert.equal(calls[1].options.redirect, "manual");
    assert.equal(calls[2].options.headers?.Authorization, undefined);
    assert.equal(calls[2].options.redirect, "manual");
    assert.equal(await readFile(destinationPath, "utf8"), bytes.toString());
    assert.deepEqual(receipt, { path: destinationPath, bytes: bytes.length, sha256: sha256(bytes) });
  });
});

test("download rejects a trusted hostname on an unapproved redirect port", async () => {
  await withTempRoots(async ({ allowed }) => {
    let calls = 0;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async (url) => {
        calls += 1;
        if (String(url).endsWith("/rest/api/3/attachment/7001")) {
          return jsonResponse(200, {
            id: "7001",
            filename: "review.pdf",
            size: 3,
            mimeType: "application/pdf",
            content: `${BASE_URL}/rest/api/3/attachment/content/7001`,
          });
        }
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.media.atlassian.com:444/file/7001" },
        });
      },
    });

    await assert.rejects(
      () => transfer.download({ attachmentId: "7001", destinationPath: join(allowed, "review.pdf"), expectedSha256: sha256("pdf"), maxBytes: 1024 }),
      /redirect destination is not trusted/,
    );
    assert.equal(calls, 2);
  });
});

test("download accepts Jira's plain-text delivery of hash-verified Markdown", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("# Fictional letter\n");
    const transfer = new AttachmentTransfer({ baseUrl: BASE_URL, authorization: AUTH, allowedRoots: [allowed],
      fetchImpl: async (url) => String(url).endsWith("/rest/api/3/attachment/7001")
        ? jsonResponse(200, { size: bytes.length, mimeType: "text/markdown", content: `${BASE_URL}/rest/api/3/attachment/content/7001` })
        : new Response(bytes, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    });
    const path = join(allowed, "letter.md");
    const receipt = await transfer.download({ attachmentId: "7001", destinationPath: path, expectedSha256: sha256(bytes), maxBytes: 1024 });
    assert.equal(receipt.sha256, sha256(bytes));
    assert.deepEqual(await readFile(path), bytes);
  });
});

test("download rejects byte size, hash and content type mismatches without writing", async (t) => {
  const cases = [
    {
      name: "size",
      metadata: { size: 99, mimeType: "application/pdf" },
      headers: { "content-type": "application/pdf" },
      expectedHash: sha256("pdf"),
      pattern: /size mismatch/,
    },
    {
      name: "hash",
      metadata: { size: 3, mimeType: "application/pdf" },
      headers: { "content-type": "application/pdf" },
      expectedHash: "0".repeat(64),
      pattern: /SHA-256 mismatch/,
    },
    {
      name: "type",
      metadata: { size: 3, mimeType: "application/pdf" },
      headers: { "content-type": "text/plain" },
      expectedHash: sha256("pdf"),
      pattern: /media type mismatch/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withTempRoots(async ({ allowed }) => {
        const destinationPath = join(allowed, `${item.name}.pdf`);
        const transfer = new AttachmentTransfer({
          baseUrl: BASE_URL,
          authorization: AUTH,
          allowedRoots: [allowed],
          fetchImpl: async (url) => String(url).endsWith("/rest/api/3/attachment/7001")
            ? jsonResponse(200, {
              id: "7001",
              filename: `${item.name}.pdf`,
              content: `${BASE_URL}/rest/api/3/attachment/content/7001`,
              ...item.metadata,
            })
            : new Response("pdf", { status: 200, headers: item.headers }),
        });

        await assert.rejects(
          () => transfer.download({ attachmentId: "7001", destinationPath, expectedSha256: item.expectedHash, maxBytes: 1024 }),
          item.pattern,
        );
        await assert.rejects(() => readFile(destinationPath), /ENOENT/);
      });
    });
  }
});

test("download rejects a symlink-escaped destination", async () => {
  await withTempRoots(async ({ allowed, outside }) => {
    const escape = join(allowed, "escape");
    await symlink(outside, escape, "junction");
    let calls = 0;
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl: async () => { calls += 1; return jsonResponse(500, {}); },
    });

    await assert.rejects(
      () => transfer.download({ attachmentId: "7001", destinationPath: join(escape, "review.pdf"), expectedSha256: sha256("pdf"), maxBytes: 1024 }),
      /outside configured roots/,
    );
    assert.equal(calls, 0);
  });
});

test("concurrent downloads never clobber a destination created after validation", async () => {
  await withTempRoots(async ({ allowed }) => {
    const destinationPath = join(allowed, "review.pdf");
    const bytesById = {
      "7001": Buffer.from("first packet"),
      "7002": Buffer.from("second packet"),
    };
    let arrivals = 0;
    let release;
    const bothDownloadsReady = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async (url) => {
      const match = String(url).match(/attachment\/(?:content\/)?(700[12])$/);
      const id = match?.[1];
      if (!String(url).includes("/content/")) {
        return jsonResponse(200, {
          id,
          filename: "review.pdf",
          size: bytesById[id].length,
          mimeType: "application/pdf",
          content: `${BASE_URL}/rest/api/3/attachment/content/${id}`,
        });
      }
      arrivals += 1;
      if (arrivals === 2) release();
      await bothDownloadsReady;
      return new Response(bytesById[id], {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      fetchImpl,
    });

    const results = await Promise.allSettled([
      transfer.download({ attachmentId: "7001", destinationPath, expectedSha256: sha256(bytesById["7001"]), maxBytes: 1024 }),
      transfer.download({ attachmentId: "7002", destinationPath, expectedSha256: sha256(bytesById["7002"]), maxBytes: 1024 }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winner = results.findIndex((result) => result.status === "fulfilled") === 0 ? "7001" : "7002";
    assert.deepEqual(await readFile(destinationPath), bytesById[winner]);
  });
});

test("download returns its receipt when published temp cleanup fails once", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("verified packet");
    const destinationPath = join(allowed, "review.pdf");
    let cleanupAttempts = 0;
    const warnings = [];
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      unlinkFileImpl: async (filePath) => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          const error = new Error(`cannot remove ${filePath}`);
          error.code = "EPERM";
          throw error;
        }
        await unlink(filePath);
      },
      warnImpl: (message) => warnings.push(message),
      fetchImpl: async (url) => String(url).endsWith("/rest/api/3/attachment/7001")
        ? jsonResponse(200, {
          id: "7001",
          filename: "review.pdf",
          size: bytes.length,
          mimeType: "application/pdf",
          content: `${BASE_URL}/rest/api/3/attachment/content/7001`,
        })
        : new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    });

    const receipt = await transfer.download({
      attachmentId: "7001",
      destinationPath,
      expectedSha256: sha256(bytes),
      maxBytes: 1024,
    });

    assert.deepEqual(receipt, { path: destinationPath, bytes: bytes.length, sha256: sha256(bytes) });
    assert.deepEqual(await readFile(destinationPath), bytes);
    assert.equal(cleanupAttempts, 2);
    assert.deepEqual(warnings, []);
  });
});

test("download returns its receipt and warns without paths when published temp cleanup remains blocked", async () => {
  await withTempRoots(async ({ allowed }) => {
    const bytes = Buffer.from("verified packet");
    const destinationPath = join(allowed, "review.pdf");
    let cleanupAttempts = 0;
    const warnings = [];
    const transfer = new AttachmentTransfer({
      baseUrl: BASE_URL,
      authorization: AUTH,
      allowedRoots: [allowed],
      unlinkFileImpl: async (filePath) => {
        cleanupAttempts += 1;
        const error = new Error(`cannot remove ${filePath}`);
        error.code = "EPERM";
        throw error;
      },
      warnImpl: (message) => warnings.push(message),
      fetchImpl: async (url) => String(url).endsWith("/rest/api/3/attachment/7001")
        ? jsonResponse(200, {
          id: "7001",
          filename: "review.pdf",
          size: bytes.length,
          mimeType: "application/pdf",
          content: `${BASE_URL}/rest/api/3/attachment/content/7001`,
        })
        : new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    });

    const receipt = await transfer.download({
      attachmentId: "7001",
      destinationPath,
      expectedSha256: sha256(bytes),
      maxBytes: 1024,
    });

    assert.deepEqual(receipt, { path: destinationPath, bytes: bytes.length, sha256: sha256(bytes) });
    assert.deepEqual(await readFile(destinationPath), bytes);
    assert.equal(cleanupAttempts, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /destination published.*cleanup failed.*EPERM/i);
    assert.equal(warnings[0].includes(allowed), false);
    assert.equal(warnings[0].includes(destinationPath), false);
  });
});
